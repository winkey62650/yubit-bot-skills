const MAX_BULK_DELETE_RULES = 100;

function inputError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

export function normalizeBulkDeleteIds(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw inputError("请至少选择一条规则");
  }
  if (input.some((id) => typeof id !== "string" || !id.trim())) {
    throw inputError("规则 ID 必须是非空字符串");
  }

  const ids = [...new Set(input.map((id) => id.trim()))];
  if (ids.length > MAX_BULK_DELETE_RULES) {
    throw inputError(`单次最多删除 ${MAX_BULK_DELETE_RULES} 条规则`);
  }
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
  return {
    ok: failed === 0,
    requested: ids.length,
    deleted,
    failed,
    results
  };
}
