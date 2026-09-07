// ============================================================
// SinterIQ / Innovista Research AI — Jenkins Declarative Pipeline
//
// Runs on the EXISTING Jenkins (jenkins.zengineeringapp.com) that already
// builds pomotoro and tawazun. This job is fully independent — it touches
// nothing belonging to them.
//
// Flow:  checkout -> build the single app image -> push to Docker Hub
//        -> deploy on the host via the mounted docker.sock (compose up -d)
//        -> health check (auto-rollback to the previous image on failure)
//
// No SSH: Jenkins has /var/run/docker.sock mounted, so `docker compose` acts
// on the host Docker directly (same mechanism the pomotoro job uses).
//
// ---- How this differs from the pomotoro job ----
//  * ONE image, not two. server.ts serves the API and the built bundle from a
//    single Node process, so there is no web/api split — just tag `app-<sha>`.
//  * Health path is /api/health, NOT /health.
//  * No AI key build arg: provider keys are runtime env only, so they never
//    land in an image layer or the browser bundle.
//
// Required Jenkins credentials:
//   - 'dockerhub-yasin' : Username/Password — Docker Hub 'yasinshaikh111' + access token.
//   - 'sinteriq-env'    : Secret file — the production .env (see .env.production.example).
//   - SCM credential to clone github.com/sageershaggy/SinterIQ — if the repo is
//     private, add a read-only ed25519 deploy key as an SSH credential and set
//     it on the job's Git SCM config.
//
// NOTE: DOCKER_CONFIG is pinned to a per-build dir so `docker login` here NEVER
// touches the shared Jenkins Docker Hub auth the pomotoro/tawazun jobs rely on.
// ============================================================

pipeline {
  agent any

  environment {
    REGISTRY     = 'docker.io'
    IMAGE_OWNER  = 'yasinshaikh111'                 // Docker Hub namespace
    IMAGE_REPO   = 'sinteriq'                       // single PRIVATE repo
    REPO_REF     = "${REGISTRY}/${IMAGE_OWNER}/${IMAGE_REPO}"

    PROJECT      = 'sinteriq'                       // compose project name (stable -> stable volume/containers)
    COMPOSE_FILE = 'docker-compose.prod.yml'
    DOMAIN       = 'sinteriq.zengineeringapp.com'   // health check target (served by host nginx)
    HEALTH_PATH  = '/api/health'                    // NOT /health — this app namespaces it under /api

    // Isolated docker client config — keeps SinterIQ's Docker Hub login out of
    // the shared Jenkins config so other jobs' auth is never overwritten.
    DOCKER_CONFIG = "${env.WORKSPACE}/.docker"

    TAG          = "${env.GIT_COMMIT?.take(12) ?: env.BUILD_NUMBER}"
  }

  options {
    timestamps()
    disableConcurrentBuilds()
    buildDiscarder(logRotator(numToKeepStr: '20'))
  }

  stages {
    stage('Checkout') {
      steps { checkout scm }
    }

    stage('Build image') {
      steps {
        sh '''
          docker build \
            -t ${REPO_REF}:app-${TAG} -t ${REPO_REF}:app-latest \
            -f Dockerfile .
        '''
      }
    }

    stage('Push to Docker Hub') {
      steps {
        withCredentials([usernamePassword(credentialsId: 'dockerhub-yasin',
                         usernameVariable: 'REG_USER', passwordVariable: 'REG_PASS')]) {
          sh '''
            mkdir -p "$DOCKER_CONFIG"
            echo "$REG_PASS" | docker login ${REGISTRY} -u "$REG_USER" --password-stdin
            docker push ${REPO_REF}:app-${TAG}
            docker push ${REPO_REF}:app-latest
          '''
        }
      }
    }

    stage('Deploy') {
      steps {
        withCredentials([file(credentialsId: 'sinteriq-env', variable: 'ENV_SRC')]) {
          script {
            // Remember the currently-running image for rollback (empty on first deploy).
            env.PREV_APP = sh(returnStdout: true, script:
              "docker inspect --format '{{.Config.Image}}' sinteriq-app 2>/dev/null || true").trim()
          }
          sh '''
            cp "$ENV_SRC" .env.deploy

            # Force the tag we just built/pushed into the env used for this deploy.
            if grep -q '^IMAGE_TAG=' .env.deploy; then
              sed -i "s|^IMAGE_TAG=.*|IMAGE_TAG=${TAG}|" .env.deploy
            else
              echo "IMAGE_TAG=${TAG}" >> .env.deploy
            fi

            # Guard the legacy bind mount: Docker silently turns a missing bind
            # path into a DIRECTORY, and the app cannot open that as a database.
            LEGACY_PATH=$(sed -n 's/^LEGACY_DB_HOST_PATH=//p' .env.deploy)
            if [ -n "$LEGACY_PATH" ] && [ ! -f "$LEGACY_PATH" ]; then
              rm -f .env.deploy
              echo "FATAL: LEGACY_DB_HOST_PATH=$LEGACY_PATH is not an existing file on the host."
              echo "Upload sintertechnik.db there first (docs/DEPLOYMENT.md step 2),"
              echo "or clear LEGACY_DB_HOST_PATH and drop that mount to start clean."
              exit 1
            fi

            docker compose -p ${PROJECT} -f ${COMPOSE_FILE} --env-file .env.deploy pull
            docker compose -p ${PROJECT} -f ${COMPOSE_FILE} --env-file .env.deploy up -d
            rm -f .env.deploy

            # Prune ONLY this app's dangling images — never touches pomotoro/tawazun.
            docker image prune -f --filter "label=com.zengineering.app=sinteriq"
          '''
        }
      }
    }

    stage('Health check') {
      steps {
        sh '''
          for i in $(seq 1 20); do
            if curl -fsS https://${DOMAIN}${HEALTH_PATH} >/dev/null; then
              echo "Health OK"; exit 0
            fi
            echo "waiting for health... ($i)"; sleep 6
          done
          echo "Health check FAILED"
          docker logs --tail 80 sinteriq-app || true
          exit 1
        '''
      }
    }
  }

  post {
    failure {
      script {
        if (env.PREV_APP?.trim()) {
          echo "Rolling back to previous image: ${env.PREV_APP}"
          // PREV_APP looks like docker.io/yasinshaikh111/sinteriq:app-<oldsha>.
          // Strip down to the bare IMAGE_TAG (drop the 'app-' role prefix).
          def prevTag = env.PREV_APP.tokenize(':').last().replaceFirst(/^app-/, '')
          withCredentials([file(credentialsId: 'sinteriq-env', variable: 'ENV_SRC')]) {
            sh """
              cp "\$ENV_SRC" .env.rollback
              if grep -q '^IMAGE_TAG=' .env.rollback; then
                sed -i 's|^IMAGE_TAG=.*|IMAGE_TAG=${prevTag}|' .env.rollback
              else
                echo 'IMAGE_TAG=${prevTag}' >> .env.rollback
              fi
              docker compose -p ${PROJECT} -f ${COMPOSE_FILE} --env-file .env.rollback up -d || true
              rm -f .env.rollback
            """
          }
        } else {
          echo "No previous image recorded — nothing to roll back to."
        }
      }
    }
    always {
      sh 'docker image prune -f --filter "label=com.zengineering.app=sinteriq" || true'
    }
  }
}
