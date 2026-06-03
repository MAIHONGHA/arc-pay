import { useEffect, useState } from "react";

const API_BASE = window.location.origin;

export default function PayrollPanel() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [batches, setBatches] = useState([]);
  const [selectedBatchItems, setSelectedBatchItems] = useState([]);
  const [csvText, setCsvText] = useState("");

  const [newPayroll, setNewPayroll] = useState({
  title: "Monthly Payroll",
  frequency: "monthly",
  pay_date: "",
  employees: [
    {
      employee_name: "",
      employee_email: "",
      wallet: "",
      base_salary: "",
      overtime_hours: "0",
      overtime_rate: "0",
      allowance: "0",
      bonus: "0",
      deduction: "0",
    },
  ],
});

  async function loadPayroll() {
    setLoading(true);

    try {
      const res = await fetch(`${API_BASE}/api/payroll-items`);
      const data = await res.json();
      setItems(data);
    } catch (err) {
      console.error(err);
      alert("Failed to load payroll");
    } finally {
      setLoading(false);
    }
  }

  async function loadPayrollBatches() {
    const res = await fetch(`${API_BASE}/api/payroll-batches`);
    const data = await res.json();
    setBatches(data);
  }

function importEmployeesFromCsv() {
  const lines = csvText.trim().split("\n");

  const employees = lines.slice(1).map((line) => {
    const [employee_name, employee_email, wallet, base_salary, bonus] =
      line.split(",").map((v) => v.trim());

    return {
      employee_name,
      employee_email,
      wallet,
      base_salary: base_salary || "0",
      overtime_hours: "0",
      overtime_rate: "0",
      allowance: "0",
      bonus: bonus || "0",
      deduction: "0",
    };
  });

  setNewPayroll({
    ...newPayroll,
    employees,
  });

  alert(`Imported ${employees.length} employees ✅`);
}

async function createPayrollBatch() {
  const res = await fetch(`${API_BASE}/api/payroll-batches`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title: newPayroll.title,
      frequency: newPayroll.frequency,
      pay_date: newPayroll.pay_date,
      employees: newPayroll.employees.map((emp) => ({
  employee_name: emp.employee_name,
  employee_email: emp.employee_email,
  wallet: emp.wallet,
  base_salary: Number(emp.base_salary || 0),
  overtime_hours: Number(emp.overtime_hours || 0),
  overtime_rate: Number(emp.overtime_rate || 0),
  allowance: Number(emp.allowance || 0),
  bonus: Number(emp.bonus || 0),
  deduction: Number(emp.deduction || 0),
})),
    }),
  });

  const data = await res.json();

  if (!res.ok) {
    alert(data.error || "Create payroll failed");
    return;
  }

  alert("Payroll created ✅");

  loadPayroll();
  loadPayrollBatches();
}

async function viewBatchItems(batchId) {
  const res = await fetch(`${API_BASE}/api/payroll-batches/${batchId}/items`);
  const data = await res.json();
  setSelectedBatchItems(data);
}

  async function approvePayroll(batchId) {
    if (!confirm("Approve this payroll batch?")) return;

    const res = await fetch(
      `${API_BASE}/api/payroll-batches/${batchId}/approve`,
      {
        method: "POST",
      }
    );

    const data = await res.json();

    if (!res.ok) {
      alert(data.error || "Approve payroll failed");
      return;
    }

    alert("Payroll approved ✅");

    loadPayroll();
    loadPayrollBatches();
  }

  async function executePayroll(batchId) {
    if (!confirm("Execute payroll now?")) return;

    const res = await fetch(
      `${API_BASE}/api/payroll-batches/${batchId}/execute`,
      {
        method: "POST",
      }
    );

    const data = await res.json();

    if (!res.ok) {
      alert(data.error || "Execute payroll failed");
      return;
    }

    alert("Payroll executed ✅");

    loadPayroll();
    loadPayrollBatches();
  }

  async function unapprovePayroll(batchId) {
    if (!confirm("Move payroll back to DRAFT?")) return;

    const res = await fetch(
      `${API_BASE}/api/payroll-batches/${batchId}/unapprove`,
      {
        method: "POST",
      }
    );

    const data = await res.json();

    if (!res.ok) {
      alert(data.error || "Unapprove payroll failed");
      return;
    }

    alert("Payroll moved back to DRAFT ✅");

    loadPayroll();
    loadPayrollBatches();
  }

  async function cancelPayroll(batchId) {
    if (!confirm("Cancel payroll batch?")) return;

    const res = await fetch(
      `${API_BASE}/api/payroll-batches/${batchId}/cancel`,
      {
        method: "POST",
      }
    );

    const data = await res.json();

    if (!res.ok) {
      alert(data.error || "Cancel payroll failed");
      return;
    }

    alert("Payroll cancelled ❌");

    loadPayroll();
    loadPayrollBatches();
  }

  async function editPayrollItem(item) {
    const base_salary = prompt("Base salary:", item.base_salary);
    if (base_salary === null) return;

    const overtime_hours = prompt(
      "Overtime hours:",
      item.overtime_hours
    );
    if (overtime_hours === null) return;

    const overtime_rate = prompt(
      "Overtime rate:",
      item.overtime_rate
    );
    if (overtime_rate === null) return;

    const allowance = prompt("Allowance:", item.allowance);
    if (allowance === null) return;

    const bonus = prompt("Bonus:", item.bonus);
    if (bonus === null) return;

    const deduction = prompt("Deduction:", item.deduction);
    if (deduction === null) return;

    const res = await fetch(
      `${API_BASE}/api/payroll-items/${item.id}/update`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          base_salary,
          overtime_hours,
          overtime_rate,
          allowance,
          bonus,
          deduction,
        }),
      }
    );

    const data = await res.json();

    if (!res.ok) {
      alert(data.error || "Update payroll failed");
      return;
    }

    alert(`Payroll updated ✅ Final: ${data.finalAmount} USDC`);

    loadPayroll();
    loadPayrollBatches();
  }

  async function sendPayslip(item) {
    if (!confirm(`Send payslip to ${item.employee_email}?`)) return;

    const res = await fetch(
      `${API_BASE}/api/payroll-items/${item.id}/send-payslip`,
      {
        method: "POST",
      }
    );

    const data = await res.json();

    if (!res.ok) {
      alert(data.error || "Send payslip failed");
      return;
    }

    alert("Payslip sent ✅");
  }

  useEffect(() => {
    loadPayroll();
    loadPayrollBatches();
  }, []);

  const total = items.reduce(
    (sum, item) => sum + Number(item.final_amount || 0),
    0
  );

  return (
    <>
<section className="glass-card">
  <h2>💼 Create Payroll</h2>

  <input
    placeholder="Payroll title"
    value={newPayroll.title}
    onChange={(e) =>
      setNewPayroll({ ...newPayroll, title: e.target.value })
    }
  />

  <select
    value={newPayroll.frequency}
    onChange={(e) =>
      setNewPayroll({ ...newPayroll, frequency: e.target.value })
    }
  >
    <option value="once">Once</option>
    <option value="monthly">Monthly</option>
  </select>

  <input
    type="datetime-local"
    value={newPayroll.pay_date}
    onChange={(e) =>
      setNewPayroll({ ...newPayroll, pay_date: e.target.value })
    }
  />

  {newPayroll.employees.map((emp, index) => (
  <div
    key={index}
    className="card"
    style={{ marginBottom: 12 }}
  >
    <input
      placeholder="Employee name"
      value={emp.employee_name}
      onChange={(e) => {
        const updated = [...newPayroll.employees];
        updated[index].employee_name = e.target.value;

        setNewPayroll({
          ...newPayroll,
          employees: updated,
        });
      }}
    />

    <input
      placeholder="Employee email"
      value={emp.employee_email}
      onChange={(e) => {
        const updated = [...newPayroll.employees];
        updated[index].employee_email = e.target.value;

        setNewPayroll({
          ...newPayroll,
          employees: updated,
        });
      }}
    />

    <input
      placeholder="Employee wallet"
      value={emp.wallet}
      onChange={(e) => {
        const updated = [...newPayroll.employees];
        updated[index].wallet = e.target.value;

        setNewPayroll({
          ...newPayroll,
          employees: updated,
        });
      }}
    />

    <input
      placeholder="Base salary"
      value={emp.base_salary}
      onChange={(e) => {
        const updated = [...newPayroll.employees];
        updated[index].base_salary = e.target.value;

        setNewPayroll({
          ...newPayroll,
          employees: updated,
        });
      }}
    />
  </div>
))}

<h3>Import Employees CSV</h3>

<textarea
  placeholder={`employee_name,email,wallet,base_salary,bonus
Mai,mai@test.com,0xabc...,100,10
An,an@test.com,0xdef...,80,0`}
  value={csvText}
  onChange={(e) => setCsvText(e.target.value)}
/>

<button onClick={importEmployeesFromCsv}>
  Import CSV
</button>

<button
  onClick={() => {
    setNewPayroll({
      ...newPayroll,
      employees: [
        ...newPayroll.employees,
        {
          employee_name: "",
          employee_email: "",
          wallet: "",
          base_salary: "",
          overtime_hours: "0",
          overtime_rate: "0",
          allowance: "0",
          bonus: "0",
          deduction: "0",
        },
      ],
    });
  }}
>
  Add Employee
</button>

  <button onClick={createPayrollBatch}>
    Create Payroll
  </button>
</section>

      <section className="card">
  <h2>Payroll</h2>

  <button onClick={loadPayroll}>
    {loading ? "Loading..." : "Refresh Payroll"}
  </button>

  <h3>Total Payroll: {total} USDC</h3>

{items[0]?.batch_id && (
  <div style={{ marginBottom: 12 }}>
    {items[0].status === "DRAFT" && (
      <>
        <button
          onClick={() => approvePayroll(items[0].batch_id)}
        >
          Approve Payroll
        </button>

        <button
          onClick={() => cancelPayroll(items[0].batch_id)}
          style={{ marginLeft: 8 }}
        >
          Cancel Payroll
        </button>
      </>
    )}

    {(items[0]?.status === "APPROVED" ||
      items[0]?.status === "REVIEW") && (
      <>
        <button
          onClick={() => executePayroll(items[0].batch_id)}
        >
          {items[0]?.status === "REVIEW"
            ? "Execute Reviewed Payroll"
            : "Execute Payroll"}
        </button>

        <button
          onClick={() => unapprovePayroll(items[0].batch_id)}
          style={{ marginLeft: 8 }}
        >
          Unapprove Payroll
        </button>

        <button
          onClick={() => cancelPayroll(items[0].batch_id)}
          style={{ marginLeft: 8 }}
        >
          Cancel Payroll
        </button>
      </>
    )}

    {items[0]?.status === "PAID" && (
      <b>Payroll Paid ✅</b>
    )}

    {items[0]?.status === "CANCELLED" && (
      <b>Payroll Cancelled ❌</b>
    )}
  </div>
)}

{items.map((item) => (
  <div
    key={item.id}
    className="card"
    style={{ marginBottom: 10 }}
  >
    <b>{item.employee_name}</b>

    <div>Email: {item.employee_email}</div>
    <div>Wallet: {item.wallet}</div>

    <div>Base Salary: {item.base_salary} USDC</div>

    <div>
      Overtime: {item.overtime_hours}h × {item.overtime_rate}
    </div>

    <div>Allowance: {item.allowance} USDC</div>
    <div>Bonus: {item.bonus} USDC</div>
    <div>Deduction: {item.deduction} USDC</div>

    <hr />

    <b>Final Amount: {item.final_amount} USDC</b>

    <div>Status: {item.status}</div>

    <button
      onClick={() => sendPayslip(item)}
      style={{ marginLeft: 8 }}
    >
      📧 Email Payslip
    </button>

    {item.status !== "PAID" && (
      <button onClick={() => editPayrollItem(item)}>
        Edit
      </button>
    )}

    {item.tx_hash && (
      <div>
        TX:{" "}
        <a
          href={`https://testnet.arcscan.app/tx/${item.tx_hash}`}
          target="_blank"
          rel="noreferrer"
        >
          View TX
        </a>
      </div>
    )}
  </div>
))}
</section>

<section className="card">
  <h2>Payroll History</h2>

  <button onClick={loadPayrollBatches}>
    Refresh History
  </button>

  {batches.map((batch) => (
    <div
      key={batch.id}
      className="card"
      style={{ marginBottom: 10 }}
    >
      <b>{batch.title}</b>

      <div>Status: {batch.status}</div>
      <div>Frequency: {batch.frequency}</div>
      <div>Pay Date: {batch.pay_date}</div>
      <div>Total: {batch.total_amount} USDC</div>
      <div>Employees: {batch.employee_count}</div>

      <button onClick={() => viewBatchItems(batch.id)}>
        View Items
      </button>
    </div>
  ))}
</section>

{selectedBatchItems.length > 0 && (
  <div className="card">
    <h3>Selected Batch Items</h3>

    {selectedBatchItems.map((item) => (
      <div
        key={item.id}
        className="card"
        style={{ marginBottom: 10 }}
      >
        <b>{item.employee_name}</b>
        <div>Email: {item.employee_email}</div>
        <div>Final: {item.final_amount} USDC</div>
        <div>Status: {item.status}</div>
      </div>
    ))}
  </div>
)}
</>
);
}