import React, { useEffect, useState } from 'react';
import { Euro, Calendar, CheckCircle2, AlertCircle, Plus } from 'lucide-react';

export default function CommissionsTab() {
  const [orders, setOrders] = useState<any[]>([]);
  const [companies, setCompanies] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [orderForm, setOrderForm] = useState({
    company_id: '',
    order_reference: '',
    order_date: new Date().toISOString().split('T')[0],
    order_value_eur: '',
    product_type: 'CERAMIC_BEARING',
    is_hybrid: false,
    payment_received: false,
    innovista_contribution: 'LEAD_GEN'
  });

  const fetchData = () => {
    Promise.all([
      fetch('/api/orders').then(res => res.json()),
      fetch('/api/companies').then(res => res.json())
    ]).then(([ordersData, companiesData]) => {
      setOrders(ordersData);
      setCompanies(companiesData);
      setLoading(false);
    }).catch(err => {
      console.error(err);
      setLoading(false);
    });
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleAddOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...orderForm,
          company_id: parseInt(orderForm.company_id),
          order_value_eur: parseFloat(orderForm.order_value_eur)
        })
      });
      setShowForm(false);
      setOrderForm({
        company_id: '',
        order_reference: '',
        order_date: new Date().toISOString().split('T')[0],
        order_value_eur: '',
        product_type: 'CERAMIC_BEARING',
        is_hybrid: false,
        payment_received: false,
        innovista_contribution: 'LEAD_GEN'
      });
      fetchData();
    } catch (err) {
      console.error(err);
      alert('Failed to add order');
    }
  };

  const totalEarned = orders.filter(o => o.payment_received).reduce((sum, o) => sum + (o.commission_eur || 0), 0);
  const totalPending = orders.filter(o => !o.payment_received).reduce((sum, o) => sum + (o.commission_eur || 0), 0);

  if (loading) return <div className="p-8 text-center text-slate-500">Loading commissions...</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">Commissions & Orders</h1>
        <button 
          onClick={() => setShowForm(!showForm)}
          className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md text-sm font-medium transition-colors flex items-center gap-2 shadow-sm"
        >
          <Plus className="w-4 h-4" />
          Add Order
        </button>
      </div>
      
      {showForm && (
        <form onSubmit={handleAddOrder} className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Company</label>
            <select required value={orderForm.company_id} onChange={e => setOrderForm({...orderForm, company_id: e.target.value})} className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm bg-white">
              <option value="">Select a company...</option>
              {companies.map(c => (
                <option key={c.id} value={c.id}>{c.company_name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Order Reference</label>
            <input type="text" required value={orderForm.order_reference} onChange={e => setOrderForm({...orderForm, order_reference: e.target.value})} className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Order Date</label>
            <input type="date" required value={orderForm.order_date} onChange={e => setOrderForm({...orderForm, order_date: e.target.value})} className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Order Value (€)</label>
            <input type="number" step="0.01" required value={orderForm.order_value_eur} onChange={e => setOrderForm({...orderForm, order_value_eur: e.target.value})} className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Product Type</label>
            <select value={orderForm.product_type} onChange={e => setOrderForm({...orderForm, product_type: e.target.value})} className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm bg-white">
              <option value="CERAMIC_BEARING">Ceramic Bearing</option>
              <option value="HYBRID_BEARING">Hybrid Bearing</option>
              <option value="CERAMIC_COMPONENT">Ceramic Component</option>
              <option value="OTHER">Other</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Contribution Type</label>
            <select value={orderForm.innovista_contribution} onChange={e => setOrderForm({...orderForm, innovista_contribution: e.target.value})} className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm bg-white">
              <option value="LEAD_GEN">Lead Generation</option>
              <option value="INTRODUCTION">Introduction</option>
              <option value="ACTIVE_SUPPORT">Active Support</option>
            </select>
          </div>
          <div className="flex items-center gap-6 mt-4">
            <label className="flex items-center gap-2 text-sm font-medium text-slate-700 cursor-pointer">
              <input type="checkbox" checked={orderForm.is_hybrid} onChange={e => setOrderForm({...orderForm, is_hybrid: e.target.checked})} className="rounded text-blue-600 focus:ring-blue-500" />
              Hybrid Bearing (Case-by-case)
            </label>
            <label className="flex items-center gap-2 text-sm font-medium text-slate-700 cursor-pointer">
              <input type="checkbox" checked={orderForm.payment_received} onChange={e => setOrderForm({...orderForm, payment_received: e.target.checked})} className="rounded text-green-600 focus:ring-green-500" />
              Payment Received
            </label>
          </div>
          <div className="col-span-1 md:col-span-2 flex justify-end gap-3 mt-2">
            <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-md font-medium transition-colors">Cancel</button>
            <button type="submit" className="px-4 py-2 text-sm bg-blue-600 text-white hover:bg-blue-700 rounded-md font-medium transition-colors">Save Order</button>
          </div>
        </form>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-slate-500 mb-1">Total Earned (Paid)</h3>
            <div className="text-3xl font-bold text-green-600">€{totalEarned.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
          </div>
          <div className="w-12 h-12 bg-green-100 text-green-600 rounded-full flex items-center justify-center">
            <CheckCircle2 className="w-6 h-6" />
          </div>
        </div>
        <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-slate-500 mb-1">Total Pending</h3>
            <div className="text-3xl font-bold text-orange-600">€{totalPending.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
          </div>
          <div className="w-12 h-12 bg-orange-100 text-orange-600 rounded-full flex items-center justify-center">
            <AlertCircle className="w-6 h-6" />
          </div>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <div className="p-4 border-b border-slate-200 bg-slate-50">
          <h3 className="font-semibold text-slate-900">Order History</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-500">
              <tr>
                <th className="px-6 py-3 font-medium">Date</th>
                <th className="px-6 py-3 font-medium">Reference</th>
                <th className="px-6 py-3 font-medium">Company</th>
                <th className="px-6 py-3 font-medium text-right">Order Value</th>
                <th className="px-6 py-3 font-medium text-right">Commission Rate</th>
                <th className="px-6 py-3 font-medium text-right">Commission (€)</th>
                <th className="px-6 py-3 font-medium text-center">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {orders.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-6 py-8 text-center text-slate-500">No orders found.</td>
                </tr>
              ) : (
                orders.map(order => (
                  <tr key={order.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-6 py-4 text-slate-600">
                      <div className="flex items-center gap-2">
                        <Calendar className="w-4 h-4 text-slate-400" />
                        {new Date(order.order_date).toLocaleDateString()}
                      </div>
                    </td>
                    <td className="px-6 py-4 font-medium text-slate-900">{order.order_reference || '-'}</td>
                    <td className="px-6 py-4 text-slate-600">{order.company_name || 'Unknown'}</td>
                    <td className="px-6 py-4 text-right text-slate-900 font-medium">€{order.order_value_eur?.toLocaleString()}</td>
                    <td className="px-6 py-4 text-right text-slate-600">
                      {order.is_hybrid ? 'Case-by-case' : order.commission_rate ? `${(order.commission_rate * 100).toFixed(1)}%` : '-'}
                    </td>
                    <td className="px-6 py-4 text-right font-medium text-slate-900">
                      {order.commission_eur ? `€${order.commission_eur.toLocaleString()}` : '-'}
                    </td>
                    <td className="px-6 py-4 text-center">
                      {order.payment_received ? (
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-green-100 text-green-700">
                          <CheckCircle2 className="w-3.5 h-3.5" /> Paid
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-orange-100 text-orange-700">
                          <AlertCircle className="w-3.5 h-3.5" /> Pending
                        </span>
                      )}
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
