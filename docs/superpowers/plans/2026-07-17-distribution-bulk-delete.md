# Distribution Bulk Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe multi-select and batch deletion to both Automatic Publishing and Telegram Broadcast rule lists.

**Architecture:** Keep the existing repository `deleteRule(id)` contract and add a focused batch-deletion service that validates and de-duplicates up to 100 IDs, executes every requested deletion, and returns per-item results. The client keeps separate automation and broadcast selections, sends one batch request, refreshes persisted data, and retains only failed visible selections.

**Tech Stack:** Next.js 15 App Router, React 18 client components, Node.js built-in test runner, Tailwind CSS, existing JSON/Neon distribution repositories.

---

## File map

- Create `lib/distribution-bulk-delete.mjs`: input validation and per-rule batch deletion result aggregation.
- Create `tests/distribution-bulk-delete.test.mjs`: service tests for invalid input, de-duplication, limits, full success, partial failure, and full failure.
- Modify `app/api/distribution/route.js`: expose authenticated `delete-many` through the existing management endpoint.
- Modify `lib/distribution-ui.mjs`: add pure selection reconciliation and result-message helpers.
- Modify `tests/distribution-ui.test.mjs`: verify selection reconciliation and partial-failure messaging.
- Modify `app/distribution/page.jsx`: add separate selection state, batch request handling, selection toolbar, accessible checkboxes, confirmation, and busy states.
- Create `tests/distribution-page.test.mjs`: source-level UI contract guard for both views and the batch action wiring.

### Task 1: Batch deletion service

**Files:**
- Create: `lib/distribution-bulk-delete.mjs`
- Create: `tests/distribution-bulk-delete.test.mjs`

- [ ] **Step 1: Write the failing validation and aggregation tests**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { deleteDistributionRules, normalizeBulkDeleteIds } from "../lib/distribution-bulk-delete.mjs";

test("bulk delete rejects empty, invalid, and oversized id lists", () => {
  assert.throws(() => normalizeBulkDeleteIds([]), /至少选择一条规则/);
  assert.throws(() => normalizeBulkDeleteIds(["rule-a", ""]), /非空字符串/);
  assert.throws(() => normalizeBulkDeleteIds(Array.from({ length: 101 }, (_, index) => `rule-${index}`)), /最多删除 100 条/);
});

test("bulk delete trims and de-duplicates rule ids", () => {
  assert.deepEqual(normalizeBulkDeleteIds([" rule-a ", "rule-a", "rule-b"]), ["rule-a", "rule-b"]);
});

test("bulk delete reports complete success", async () => {
  const repository = { deleteRule: async () => true };
  assert.deepEqual(await deleteDistributionRules(repository, ["rule-a", "rule-b"]), {
    ok: true,
    requested: 2,
    deleted: 2,
    failed: 0,
    results: [{ id: "rule-a", ok: true }, { id: "rule-b", ok: true }]
  });
});

test("bulk delete continues after missing rules and exceptions", async () => {
  const repository = {
    async deleteRule(id) {
      if (id === "missing") return false;
      if (id === "broken") throw new Error("database timeout");
      return true;
    }
  };
  const result = await deleteDistributionRules(repository, ["kept", "missing", "broken"]);
  assert.equal(result.ok, false);
  assert.equal(result.deleted, 1);
  assert.equal(result.failed, 2);
  assert.deepEqual(result.results, [
    { id: "kept", ok: true },
    { id: "missing", ok: false, error: "规则不存在或已删除" },
    { id: "broken", ok: false, error: "database timeout" }
  ]);
});

test("bulk delete reports full failure without losing item details", async () => {
  const repository = { deleteRule: async () => false };
  const result = await deleteDistributionRules(repository, ["rule-a", "rule-b"]);
  assert.equal(result.ok, false);
  assert.equal(result.deleted, 0);
  assert.equal(result.failed, 2);
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `node --test tests/distribution-bulk-delete.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/distribution-bulk-delete.mjs`.

- [ ] **Step 3: Implement validation and per-item aggregation**

```js
const MAX_BULK_DELETE_RULES = 100;

function inputError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

export function normalizeBulkDeleteIds(input) {
  if (!Array.isArray(input) || input.length === 0) throw inputError("请至少选择一条规则");
  if (input.some((id) => typeof id !== "string" || !id.trim())) throw inputError("规则 ID 必须是非空字符串");
  const ids = [...new Set(input.map((id) => id.trim()))];
  if (ids.length > MAX_BULK_DELETE_RULES) throw inputError(`单次最多删除 ${MAX_BULK_DELETE_RULES} 条规则`);
  return ids;
}

export async function deleteDistributionRules(repository, input) {
  const ids = normalizeBulkDeleteIds(input);
  const results = [];
  for (const id of ids) {
    try {
      const deleted = await repository.deleteRule(id);
      results.push(deleted
        ? { id, ok: true }
        : { id, ok: false, error: "规则不存在或已删除" });
    } catch (error) {
      results.push({ id, ok: false, error: error?.message || "删除失败" });
    }
  }
  const deleted = results.filter((result) => result.ok).length;
  const failed = results.length - deleted;
  return { ok: failed === 0, requested: ids.length, deleted, failed, results };
}
```

- [ ] **Step 4: Run the focused test and confirm it passes**

Run: `node --test tests/distribution-bulk-delete.test.mjs`

Expected: 5 tests PASS.

- [ ] **Step 5: Commit the service and tests**

```bash
git add lib/distribution-bulk-delete.mjs tests/distribution-bulk-delete.test.mjs
git commit -m "feat: add distribution batch deletion service"
```

### Task 2: Management API contract

**Files:**
- Modify: `app/api/distribution/route.js:1-32`
- Modify: `tests/distribution-bulk-delete.test.mjs`

- [ ] **Step 1: Add a failing route contract test**

Append this test:

```js
import { readFile } from "node:fs/promises";

test("distribution management route exposes one-request batch deletion", async () => {
  const source = await readFile(new URL("../app/api/distribution/route.js", import.meta.url), "utf8");
  assert.match(source, /body\.action === ["']delete-many["']/);
  assert.match(source, /deleteDistributionRules\(repository, body\.ids\)/);
});
```

- [ ] **Step 2: Run the focused test and confirm the new assertion fails**

Run: `node --test tests/distribution-bulk-delete.test.mjs`

Expected: FAIL because `delete-many` is not present in the route.

- [ ] **Step 3: Wire the service into the existing route**

Add the import:

```js
import { deleteDistributionRules } from "../../../lib/distribution-bulk-delete.mjs";
```

Add this branch immediately before the single-delete branch:

```js
if (body.action === "delete-many") {
  return NextResponse.json(await deleteDistributionRules(repository, body.ids));
}
```

The existing `catch` and `failure` functions preserve a `400` response for invalid input through `error.statusCode`.

- [ ] **Step 4: Run the focused test and syntax check**

Run: `node --test tests/distribution-bulk-delete.test.mjs && node --check app/api/distribution/route.js`

Expected: all focused tests PASS and syntax check exits 0.

- [ ] **Step 5: Commit the API route**

```bash
git add app/api/distribution/route.js tests/distribution-bulk-delete.test.mjs
git commit -m "feat: expose distribution batch delete API"
```

### Task 3: Selection helpers and user-facing result semantics

**Files:**
- Modify: `lib/distribution-ui.mjs`
- Modify: `tests/distribution-ui.test.mjs`

- [ ] **Step 1: Add failing helper tests**

Update the import list with `bulkDeleteNotice`, `failedBulkDeleteIds`, and `reconcileRuleSelection`, then append:

```js
test("rule selection is reconciled against the currently visible rules", () => {
  assert.deepEqual(reconcileRuleSelection(["rule-a", "missing", "rule-a"], [{ id: "rule-a" }, { id: "rule-b" }]), ["rule-a"]);
});

test("partial batch deletion retains failed ids and reports exact counts", () => {
  const result = {
    deleted: 2,
    failed: 1,
    results: [
      { id: "rule-a", ok: true },
      { id: "rule-b", ok: false, error: "database timeout" },
      { id: "rule-c", ok: true }
    ]
  };
  assert.deepEqual(failedBulkDeleteIds(result), ["rule-b"]);
  assert.equal(bulkDeleteNotice(result), "已删除 2 条，1 条失败：database timeout");
  assert.equal(bulkDeleteNotice({ deleted: 3, failed: 0, results: [] }), "已删除 3 条规则。");
});
```

- [ ] **Step 2: Run the UI helper tests and confirm they fail**

Run: `node --test tests/distribution-ui.test.mjs`

Expected: FAIL because the three helpers are not exported.

- [ ] **Step 3: Implement the pure helpers**

Append to `lib/distribution-ui.mjs`:

```js
export function reconcileRuleSelection(selected, rules) {
  const visible = new Set((Array.isArray(rules) ? rules : []).map((rule) => String(rule.id)));
  return [...new Set(Array.isArray(selected) ? selected.map(String) : [])].filter((id) => visible.has(id));
}

export function failedBulkDeleteIds(result) {
  return (Array.isArray(result?.results) ? result.results : [])
    .filter((item) => !item.ok)
    .map((item) => String(item.id));
}

export function bulkDeleteNotice(result) {
  const deleted = Number(result?.deleted || 0);
  const failed = Number(result?.failed || 0);
  if (!failed) return `已删除 ${deleted} 条规则。`;
  const errors = [...new Set((result.results || []).filter((item) => !item.ok).map((item) => item.error).filter(Boolean))];
  return `已删除 ${deleted} 条，${failed} 条失败${errors.length ? `：${errors.join("；")}` : ""}`;
}
```

- [ ] **Step 4: Run the UI helper tests**

Run: `node --test tests/distribution-ui.test.mjs`

Expected: all tests PASS.

- [ ] **Step 5: Commit the helpers**

```bash
git add lib/distribution-ui.mjs tests/distribution-ui.test.mjs
git commit -m "feat: add distribution selection helpers"
```

### Task 4: Automatic Publishing and Telegram Broadcast batch-selection UI

**Files:**
- Modify: `app/distribution/page.jsx:3-215,220-305,356-358`
- Create: `tests/distribution-page.test.mjs`

- [ ] **Step 1: Add a failing UI contract test**

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const page = await readFile(new URL("../app/distribution/page.jsx", import.meta.url), "utf8");

test("automatic and broadcast rules keep separate batch selections", () => {
  assert.match(page, /selectedAutomationRules/);
  assert.match(page, /selectedBroadcastRules/);
  assert.match(page, /setSelectedAutomationRules/);
  assert.match(page, /setSelectedBroadcastRules/);
});

test("rule list exposes accessible current-list selection and confirmed batch deletion", () => {
  assert.match(page, /aria-label=\{`全选\$\{kindLabel\}`\}/);
  assert.match(page, /aria-label=\{`选择规则：\$\{rule\.name\}`\}/);
  assert.match(page, /删除选中（\{selectedCount\}）/);
  assert.match(page, /确认删除.*selectedCount/);
});

test("batch deletion sends one request and retains failed selections", () => {
  assert.match(page, /action: "delete-many", ids/);
  assert.match(page, /failedBulkDeleteIds\(result\)/);
  assert.match(page, /bulkDeleteNotice\(result\)/);
});
```

- [ ] **Step 2: Run the page contract test and confirm it fails**

Run: `node --test tests/distribution-page.test.mjs`

Expected: 3 tests FAIL because batch-selection UI is absent.

- [ ] **Step 3: Add separate selection state and reconciliation**

Import the three Task 3 helpers. Add beside `selectedReviews`:

```js
const [selectedAutomationRules, setSelectedAutomationRules] = useState([]);
const [selectedBroadcastRules, setSelectedBroadcastRules] = useState([]);
```

Add reconciliation after the initial loading effect:

```js
useEffect(() => {
  const automation = data.rules.filter((rule) => rule.kind === "automation");
  const broadcast = data.rules.filter((rule) => rule.kind === "broadcast");
  setSelectedAutomationRules((current) => reconcileRuleSelection(current, automation));
  setSelectedBroadcastRules((current) => reconcileRuleSelection(current, broadcast));
}, [data.rules]);
```

- [ ] **Step 4: Add the dedicated batch request handler**

Add inside `DistributionPage`:

```js
async function deleteManyRules(ids, setSelected, kindLabel) {
  if (!ids.length) return;
  setBusy(`delete-many-${kindLabel}`);
  setNotice("");
  try {
    const response = await fetch("/api/distribution", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "delete-many", ids })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "批量删除失败");
    setSelected(failedBulkDeleteIds(result));
    setNotice(bulkDeleteNotice(result));
    await loadAll();
  } catch (error) {
    setNotice(error.message);
  } finally {
    setBusy("");
  }
}
```

Pass `selected`, `setSelected`, `busy`, and `onDeleteMany` into each view, and from each view into its `RuleList`. Use `kindLabel="自动任务"` and `kindLabel="Telegram 广播规则"` respectively.

- [ ] **Step 5: Replace `RuleList` with an accessible selection toolbar and selectable rows**

Implement these behaviors in the existing component:

```jsx
function RuleList({ rules, empty, kindLabel, selected, setSelected, busy, onDeleteMany, onEdit, onAction, onValidate }) {
  const ruleIds = rules.map((rule) => String(rule.id));
  const visibleSelected = selected.filter((id) => ruleIds.includes(id));
  const selectedCount = visibleSelected.length;
  const allSelected = Boolean(ruleIds.length) && selectedCount === ruleIds.length;
  const partiallySelected = selectedCount > 0 && !allSelected;

  function selectAll(checked) {
    setSelected(checked ? ruleIds : []);
  }

  function toggleRule(id) {
    setSelected(visibleSelected.includes(id) ? visibleSelected.filter((value) => value !== id) : [...visibleSelected, id]);
  }

  return <Card className="overflow-hidden">
    <div className="flex flex-col gap-4 border-b border-ops-line p-5 lg:flex-row lg:items-center lg:justify-between">
      <div><h2 className="text-xl font-black">现有规则</h2><p className="mt-1 text-sm text-ops-muted">稳定键使用 Chat ID + Thread ID，群或 Topic 改名不会让规则失效。</p></div>
      <div className="flex flex-wrap items-center gap-2" aria-label={`${kindLabel}批量操作`} role="group">
        <label className="flex min-h-9 items-center gap-2 rounded-lg border border-ops-line px-3 text-xs font-black text-[#33423b]">
          <input aria-label={`全选${kindLabel}`} checked={allSelected} disabled={!ruleIds.length || Boolean(busy)} onChange={(event) => selectAll(event.target.checked)} ref={(node) => { if (node) node.indeterminate = partiallySelected; }} type="checkbox" />
          全选当前列表
        </label>
        <SmallButton disabled={!selectedCount || Boolean(busy)} onClick={() => setSelected([])}>清空选择</SmallButton>
        <SmallButton danger disabled={!selectedCount || Boolean(busy)} onClick={() => window.confirm(`确认删除选中的 ${selectedCount} 条${kindLabel}？此操作不可撤销。`) && onDeleteMany(visibleSelected)}>删除选中（{selectedCount}）</SmallButton>
      </div>
    </div>
    <div className="divide-y divide-ops-line">
      {rules.length ? rules.map((rule) => <article className="flex items-start gap-3 p-5" key={rule.id}>
        <input aria-label={`选择规则：${rule.name}`} checked={visibleSelected.includes(rule.id)} className="mt-1" disabled={Boolean(busy)} onChange={() => toggleRule(rule.id)} type="checkbox" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-black">{rule.name}</h3>
                <StatusPill tone={rule.enabled ? "green" : "amber"}>{rule.runOnce ? rule.status === "completed" ? "已执行" : rule.status === "failed" ? "执行失败" : rule.status === "running" ? "执行中" : "等待执行" : rule.enabled ? "已启用" : "已暂停"}</StatusPill>
                {rule.runOnce ? <StatusPill tone="amber">一次性</StatusPill> : null}
                {rule.status === "pending-confirmation" ? <StatusPill tone="amber">待确认</StatusPill> : null}
              </div>
              <p className="mt-2 text-sm text-ops-muted">{rule.kind === "automation" ? rule.runOnce ? `${labelFor(contentTypes, rule.contentType)} · 一次性执行 · ${rule.status === "completed" ? "已完成" : rule.status === "failed" ? "失败（可在运行记录中查看原因）" : rule.status === "running" ? "正在执行" : formatTime(rule.nextRunAt)}` : `${labelFor(contentTypes, rule.contentType)} · ${labelFor(schedules, rule.schedulePreset)} · 下次 ${formatTime(rule.nextRunAt)}` : `${rule.mode === "review" ? "审核模式" : "自动模式"} · 来源 ${rule.source?.chatId}${rule.source?.threadId ? `:${rule.source.threadId}` : ":整群"}`}</p>
              <p className="mt-1 text-xs text-ops-muted">{rule.targets.length} 个目标 · {rule.targets.map((target) => `${target.groupName || target.chatId}/${target.topicName || target.threadId || "整群"}`).join("、")}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {rule.runOnce ? null : <SmallButton disabled={Boolean(busy)} onClick={() => onEdit(rule)}>编辑</SmallButton>}
              <SmallButton disabled={Boolean(busy)} onClick={() => onValidate(rule.id)}>验证配置</SmallButton>
              {rule.kind === "automation"
                ? rule.runOnce ? null : <SmallButton disabled={Boolean(busy)} onClick={() => window.confirm("将按当前模板立即向全部目标发送真实内容，确认继续？") && onAction({ action: "run-now", id: rule.id }, "真实内容已发布，结果已写入运行记录。")}>立即发布</SmallButton>
                : <SmallButton disabled={Boolean(busy)} onClick={() => onAction({ action: "test", id: rule.id }, "测试消息已按目标分别发送。")}>发送测试</SmallButton>}
              {rule.runOnce ? null : <SmallButton disabled={Boolean(busy)} onClick={() => onAction({ action: "toggle", id: rule.id, enabled: !rule.enabled }, rule.enabled ? "规则已暂停。" : "规则已启用。")}>{rule.enabled ? "暂停" : "启用"}</SmallButton>}
              <SmallButton danger disabled={Boolean(busy)} onClick={() => window.confirm("确认删除这条规则？") && onAction({ action: "delete", id: rule.id }, "规则已删除。")}>删除</SmallButton>
            </div>
          </div>
        </div>
      </article>) : <div className="p-8 text-center font-bold text-ops-muted">{empty}</div>}
    </div>
  </Card>;
}
```

The existing edit, validate, run-now, test, toggle, and single-delete payloads remain unchanged. Every row action is disabled while a batch request is active.

- [ ] **Step 6: Run focused UI tests and build**

Run: `node --test tests/distribution-page.test.mjs tests/distribution-ui.test.mjs && npm run build`

Expected: focused tests PASS; Next.js production build completes successfully.

- [ ] **Step 7: Commit the client UI**

```bash
git add app/distribution/page.jsx tests/distribution-page.test.mjs
git commit -m "feat: add bulk rule selection to distribution center"
```

### Task 5: Full regression, release, and production verification

**Files:**
- Modify: `memory/2026-07-17.md` in the workspace root after verification

- [ ] **Step 1: Run code checks and the complete automated suite**

Run: `npm run check && npm test && npm run build`

Expected: all syntax checks pass, the full Node test suite has zero failures, and the production build succeeds.

- [ ] **Step 2: Check the final diff for accidental files and whitespace errors**

Run: `git status --short && git diff --check && git log --oneline -5`

Expected: only intentional tracked changes are present; the pre-existing untracked `.superpowers/` directory remains uncommitted; `git diff --check` exits 0.

- [ ] **Step 3: Push `code/academy` and wait for the production-server deployment workflow**

Run: `git push origin code/academy`

Expected: push succeeds and the repository's production deployment workflow finishes successfully for the pushed commit.

- [ ] **Step 4: Verify batch deletion in production without touching real rules**

Using authenticated production requests:

1. Create two disabled temporary automation rules and two disabled temporary broadcast rules, each named with a `BULK-DELETE-VERIFY` prefix.
2. Open `https://152-32-161-174.sslip.io/distribution?view=automation` at 1366×768, select both temporary automation rules, confirm the count, delete them, and verify they disappear after refresh.
3. Open `https://152-32-161-174.sslip.io/distribution?view=broadcast`, repeat for the temporary broadcast rules, and verify the two selection states do not leak across tabs.
4. Re-fetch `/api/distribution` and verify only the four temporary IDs are absent; all pre-existing rule IDs remain.
5. Verify single-rule delete is still visible without activating it on production data.

Expected: both batches delete exactly the selected temporary rules, the success notice reports the correct count, refresh shows persisted deletion, and no existing task is changed.

- [ ] **Step 5: Record the release outcome**

Append a dated note to `/Users/mututu/Documents/药老百宝箱/武器库/交易所/memory/2026-07-17.md` covering the production commit, automated test count, production URL, temporary-rule cleanup, and any residual limitation. Commit the memory file only if it belongs to the same repository; otherwise leave it as workspace memory.
