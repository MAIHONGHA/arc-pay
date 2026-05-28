import { useEffect, useState } from "react";

const API_BASE = window.location.origin;

export default function PayoutPanel() {
  const [payouts, setPayouts] = useState([]);
  const [loading, setLoading] = useState(false);

  async function loadPayouts() {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/payouts`);
      const data = await res.json();
      setPayouts(data);
    } catch (err) {
      alert("Failed to load payouts");
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  async function approvePayout(id) {
    if (!confirm("Approve scheduled payout?")) return;

    await fetch(`${API_BASE}/api/payouts/${id}/approve`, {
      method: "POST",
    });

    loadPayouts();
  }

  async function confirmPayout(id) {
    if (!confirm("Confirm & send payout now?")) return;

    await fetch(`${API_BASE}/api/payouts/${id}/confirm`, {
      method: "POST",
    });

    loadPayouts();
  }

  useEffect(() => {
    loadPayouts();
  }, []);
<h1 style={{ color: "red" }}>TEST UI</h1>
  return (
    <section className="card">
      <h2>Payouts</h2>

      <button onClick={loadPayouts}>
        {loading ? "Loading..." : "Refresh"}
      </button>

      <div style={{ marginTop: 12 }}>
        {payouts.map((p) => (
          <div key={p.id} className="card" style={{ marginBottom: 10 }}>
            <div><b>{p.amount} USDC</b></div>
            <div>Recipient: {p.recipient}</div>
            <div>Status: {p.status}</div>
            <div>Mode: {p.mode}</div>

            {p.tx_hash && (
              <div>
                TX:{" "}
                <a
                  href={`https://testnet.arcscan.app/tx/${p.tx_hash}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  View TX
                </a>
              </div>
            )}

            {p.status === "PENDING" && (p.mode === "now" || !p.mode) ? (
  <button onClick={() => confirmPayout(p.id)}>
    ⚡ Pay Now
  </button>
) : p.status === "PENDING" && p.mode === "scheduled" ? (
  <button onClick={() => approvePayout(p.id)}>
    🗓 Approve Schedule
  </button>
) : p.status === "REVIEW" ? (
  <button onClick={() => confirmPayout(p.id)}>
    ✅ Confirm & Pay
  </button>
) : p.status === "APPROVED" ? (
  <p style={{ color: "orange" }}>Waiting schedule ⏳</p>
) : p.status === "PAID" ? (
  <p style={{ color: "green" }}>Paid ✅</p>
) : (
  <p style={{ color: "red" }}>{p.status}</p>
)}
          </div>
        ))}
      </div>
    </section>
  );
}