// The sole renderer for persisted login-log values. Historical rows predate the strict Rules
// schema, so every value is normalized into text nodes at render time and never into HTML,
// attributes, datasets, or event-handler state.
export function createLoginLogRow(document, row, { shortDevice, formatTime, unknownUser }) {
  const el = document.createElement("div");
  el.className = "flex items-center justify-between border-b border-borderNeon/40 py-2.5 last:border-0";
  const details = document.createElement("div");
  const email = document.createElement("p");
  email.className = "font-medium";
  email.textContent = typeof row?.email === "string" ? row.email : unknownUser;
  const device = document.createElement("p");
  device.className = "text-xs text-textGray font-code mt-0.5";
  device.textContent = shortDevice(row?.device);
  details.append(email, device);
  const time = document.createElement("span");
  time.className = "text-xs text-textGray font-code";
  time.textContent = formatTime(row?.loginTime);
  el.append(details, time);
  return el;
}
