import React, { useEffect, useState } from 'react';
import { Euro, CheckCircle2, Clock, AlertCircle, TrendingUp } from 'lucide-react';

interface Order {
  id: number;
  company_id: number;
  company_name: string;
  order_reference: string;
  order_date: string;
  order_value_eur: number;
  product_type: string;
  is_hybrid: number;
  commission_rate: number;
  commission_eur: number;
  payment_received: number;
  commission_paid: number;
  innovista_contribution: string;
}

// Amendment No. 1 commission tiers
function calculateCommissionRate(orderValue: number, isHybrid: boolean): number {
  if (isHybrid) return 0; // case-by-case for hybrid
  if (orderValue <= 500) return 0.10;
  if (orderValue <= 3000) return 0.07;
  if (orderValue <= 10000) return 0.05;
  return 0; // case-by-case for > €10,000
}

function tierLabel(orderValue: number, isHybrid: boolean): string {
  if (isHybrid) return 'Hybrid — case-by-case';
  if (orderValue <= 500) return '10% (≤€500)';
  if (orderValue <= 3000) return '7% (≤€3,000)';
  if (orderValue <= 10000) return '5% (≤€10,000)';
  return 'Case-by-case (>€10K)';
}

export default function CommissionAdmin() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/orders')
      .then(r => r.json())
      .then(data => { setOrders(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const totalEarned = orders.filter(o => o.payment_received).reduce((s, o) => s + (o.commission_eur || 0), 0);
  const totalPending = orders.filter(o => !o.payment_received).reduce((s, o) => {
    const rate = calculateCommissionRate(o.order_value_eur, !!o.is_hybrid);
    return s + (o.commission_eur || o.order_value_eur * rate);
  }, 0);
  const totalOrders = orders.reduce((s, o) => s + o.order_value_eur, 0);

  if (loading) return <div className="p-8 text-center text-slate-500">Loading commissions...</div>;

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">Commission Tracking</h1>
        <p className="text-sm text-slate-500 mt-1">Amendment No. 1 commission tiers — admin only</p>
      </div>

      {/* Tier reference */}
      <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-4">
        <h3 className="text-sm font-semibold text-indigo-800 mb-2">Commission Tiers (Amendment No. 1)</h3>
        <div className="grid grid-cols-4 gap-3 text-xs">
          <div className="bg-white rounded-lg p-2.5 border border-indigo-100">
            <div className="font-bold text-indigo-700">10%</div>
            <div className="text-slate-600">Orders ≤ €500</div>
          </div>
          <div className="bg-white rounded-lg p-2.5 border border-indigo-100">
            <div className="font-bold text-indigo-700">7%</div>
            <div className="text-slate-600">Orders ≤ €3,000</div>
          </div>
          <div className="bg-white rounded-lg p-2.5 border border-indigo-100">
            <div className="font-bold text-indigo-700">5%</div>
            <div className="text-slate-600">Orders ≤ €10,000</div>
          </div>
          <div className="bg-white rounded-lg p-2.5 border border-indigo-100">
            <div className="font-bold text-indigo-700">Case-by-case</div>
            <div className="text-slate-600">Orders &gt; €10,000 &amp; Hybrid</div>
          </div>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
          <div className="flex items-center gap-2 text-sm text-slate-500 mb-2">
            <TrendingUp className="w-4 h-4 text-blue-500" /> Total Order Value
          </div>
          <div className="text-2xl font-bold text-slate-900">€{totalOrders.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
        </div>
        <div className="bg-white border border-green-200 rounded-xl p-5 shadow-sm">
          <div className="flex items-center gap-2 text-sm text-green-600 mb-2">
            <CheckCircle2 className="w-4 h-4" /> Earned (Paid)
          </div>
          <div className="text-2xl font-bold text-green-700">€{totalEarned.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
        </div>
        <div className="bg-white border border-orange-200 rounded-xl p-5 shadow-sm">
          <div className="flex items-center gap-2 text-sm text-orange-600 mb-2">
            <Clock className="w-4 h-4" /> Pending
          </div>
          <div className="text-2xl font-bold text-orange-700">€{totalPending.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
        </div>
      </div>

      {/* Orders table */}
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 border-b border-slate-200 text-slate-500">
            <tr>
              <th className="px-4 py-3 font-medium">Date</th>
              <th className="px-4 py-3 font-medium">Company</th>
              <th className="px-4 py-3 font-medium">Reference</th>
              <th className="px-4 py-3 font-medium text-right">Order Value</th>
              <th className="px-4 py-3 font-medium">Tier</th>
              <th className="px-4 py-3 font-medium text-right">Commission</th>
              <th className="px-4 py-3 font-medium text-center">Payment</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {orders.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">No orders yet.</td></tr>
            ) : (
              orders.map(order => {
                const rate = calculateCommissionRate(order.order_value_eur, !!order.is_hybrid);
                const commission = order.commission_eur || (order.order_value_eur * rate);
                return (
                  <tr key={order.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 text-slate-600">{new Date(order.order_date).toLocaleDateString()}</td>
                    <td className="px-4 py-3 text-slate-900 font-medium">{order.company_name || `Company #${order.company_id}`}</td>
                    <td className="px-4 py-3 text-slate-600">{order.order_reference}</td>
                    <td className="px-4 py-3 text-right font-medium">€{order.order_value_eur.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                    <td className="px-4 py-3">
                      <span className="text-xs bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded-full font-medium">
                        {tierLabel(order.order_value_eur, !!order.is_hybrid)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-blue-600">
                      {rate > 0 || order.commission_eur
                        ? `€${commission.toLocaleString(undefined, { minimumFractionDigits: 2 })}`
                        : 'TBD'}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {order.payment_received ? (
                        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-green-100 text-green-700 text-xs font-medium">
                          <CheckCircle2 className="w-3 h-3" /> Paid
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-orange-100 text-orange-700 text-xs font-medium">
                          <Clock className="w-3 h-3" /> Pending
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
        <div className="flex items-center gap-2 mb-1">
          <AlertCircle className="w-4 h-4" />
          <span className="font-semibold">Note</span>
        </div>
        <p>Commission is payable only after Sintertechnik receives payment from the customer. Hybrid bearing commissions are negotiated case-by-case per Amendment No. 1.</p>
      </div>
    </div>
  );
}
