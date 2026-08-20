// Safe, DOM-only renderer for an Expense row. Every value that can originate in Firestore (and
// therefore every future AI suggestion saved after user confirmation) is assigned via
// textContent. The only class names accepted here come from the local CATEGORY_META allowlist.

function element(documentRef, tag, className, text) {
  const node = documentRef.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}

export function createExpenseRowElement(documentRef, {
  expense,
  categoryMeta,
  categoryLabel,
  formattedDate,
  amountLabel,
  editTitle,
}) {
  const row = element(documentRef, "article", "is-visible bg-cardBg/90 neon-border-purple rounded-2xl p-4 flex items-center justify-between gap-4");

  const left = element(documentRef, "div", "flex items-center gap-3 min-w-0");
  const badge = element(
    documentRef,
    "div",
    `w-9 h-9 rounded-lg ${categoryMeta.bg} ${categoryMeta.text} flex items-center justify-center text-xs font-code font-bold flex-shrink-0 border ${categoryMeta.border}`,
    categoryLabel.slice(0, 2).toUpperCase(),
  );
  const details = element(documentRef, "div", "min-w-0");
  details.append(
    element(documentRef, "p", "text-sm font-medium truncate", expense.note || categoryLabel),
    element(documentRef, "p", "text-[11px] text-textGray mt-0.5 font-code", formattedDate),
  );

  if (Array.isArray(expense.tags) && expense.tags.length) {
    const tags = element(documentRef, "div", "flex flex-wrap gap-1 mt-1");
    expense.tags.forEach((tag) => {
      tags.append(element(
        documentRef,
        "span",
        "text-[10px] font-code px-1.5 py-0.5 rounded-full border border-borderNeon text-textGray",
        `#${tag}`,
      ));
    });
    details.append(tags);
  }
  left.append(badge, details);

  const right = element(documentRef, "div", "flex items-center gap-2 flex-shrink-0");
  right.append(element(documentRef, "span", "font-code font-semibold text-sm tabular-nums", amountLabel));

  const editButton = element(documentRef, "button", "edit-expense-btn text-textGray hover:text-neonPurple transition-colors");
  editButton.type = "button";
  editButton.title = editTitle;
  editButton.append(element(documentRef, "i", "fa-solid fa-pen text-xs"));
  right.append(editButton);

  row.append(left, right);
  return row;
}
