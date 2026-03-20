import React, { useMemo, useState } from 'react';
import { Edit2, Plus, Save, UserCog, Users } from 'lucide-react';
import { AppUser } from './appTypes';
import { userRoleOptions } from './companyData';

interface UserFormState {
  email: string;
  full_name: string;
  id: number | null;
  is_active: boolean;
  notes: string;
  role: string;
}

const emptyUserForm: UserFormState = {
  id: null,
  full_name: '',
  email: '',
  role: 'Sales',
  is_active: true,
  notes: '',
};

export default function UsersTab({
  users,
  onUsersChanged,
}: {
  onUsersChanged: () => Promise<void>;
  users: AppUser[];
}) {
  const [form, setForm] = useState<UserFormState>(emptyUserForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);

  const activeCount = useMemo(() => users.filter((user) => user.is_active).length, [users]);

  const resetForm = () => {
    setForm(emptyUserForm);
    setShowForm(false);
    setError('');
  };

  const handleEdit = (user: AppUser) => {
    setForm({
      id: user.id,
      full_name: user.full_name,
      email: user.email || '',
      role: user.role || 'Sales',
      is_active: Boolean(user.is_active),
      notes: user.notes || '',
    });
    setShowForm(true);
    setError('');
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError('');

    try {
      const response = await fetch(form.id ? `/api/users/${form.id}` : '/api/users', {
        method: form.id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to save user');
      }

      await onUsersChanged();
      resetForm();
    } catch (submitError) {
      console.error(submitError);
      setError(submitError instanceof Error ? submitError.message : 'Failed to save user');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">User Management</h1>
          <p className="text-sm text-slate-500 mt-1">{activeCount} active users, {users.length - activeCount} inactive</p>
        </div>
        <button
          onClick={() => {
            setForm(emptyUserForm);
            setShowForm((currentValue) => !currentValue);
            setError('');
          }}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md text-sm font-medium transition-colors"
        >
          <Plus className="w-4 h-4" />
          New User
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="bg-white border border-slate-200 rounded-xl shadow-sm p-6 space-y-4">
          <div className="flex items-center gap-2 text-slate-900">
            <UserCog className="w-5 h-5 text-blue-500" />
            <h2 className="text-lg font-semibold">{form.id ? 'Edit User' : 'Add User'}</h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Full Name</label>
              <input
                required
                type="text"
                value={form.full_name}
                onChange={(event) => setForm({ ...form, full_name: event.target.value })}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Email</label>
              <input
                type="email"
                value={form.email}
                onChange={(event) => setForm({ ...form, email: event.target.value })}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Role</label>
              <select
                value={form.role}
                onChange={(event) => setForm({ ...form, role: event.target.value })}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm bg-white"
              >
                {userRoleOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-2 pt-7">
              <input
                id="is-active"
                type="checkbox"
                checked={form.is_active}
                onChange={(event) => setForm({ ...form, is_active: event.target.checked })}
                className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
              />
              <label htmlFor="is-active" className="text-sm text-slate-700">Active user</label>
            </div>

            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">Notes</label>
              <textarea
                rows={3}
                value={form.notes}
                onChange={(event) => setForm({ ...form, notes: event.target.value })}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
                placeholder="Responsibilities, region coverage, or ownership notes."
              />
            </div>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={resetForm}
              className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-md font-medium transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white hover:bg-blue-700 rounded-md font-medium transition-colors disabled:opacity-50"
            >
              <Save className="w-4 h-4" />
              {saving ? 'Saving...' : form.id ? 'Update User' : 'Create User'}
            </button>
          </div>
        </form>
      )}

      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <div className="p-4 border-b border-slate-200 bg-slate-50 flex items-center gap-2">
          <Users className="w-5 h-5 text-slate-500" />
          <h2 className="font-semibold text-slate-900">Team Directory</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-500">
              <tr>
                <th className="px-6 py-3 font-medium">Name</th>
                <th className="px-6 py-3 font-medium">Email</th>
                <th className="px-6 py-3 font-medium">Role</th>
                <th className="px-6 py-3 font-medium">Status</th>
                <th className="px-6 py-3 font-medium">Notes</th>
                <th className="px-6 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {users.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-8 text-center text-slate-500">No users found.</td>
                </tr>
              ) : (
                users.map((user) => (
                  <tr key={user.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-6 py-4 font-medium text-slate-900">{user.full_name}</td>
                    <td className="px-6 py-4 text-slate-600">{user.email || '-'}</td>
                    <td className="px-6 py-4 text-slate-600">{user.role || '-'}</td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                        user.is_active ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-600'
                      }`}>
                        {user.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-slate-600">{user.notes || '-'}</td>
                    <td className="px-6 py-4 text-right">
                      <button
                        onClick={() => handleEdit(user)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-md text-xs font-medium transition-colors"
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                        Edit
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
