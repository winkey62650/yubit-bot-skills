import { randomUUID } from "node:crypto";
import { authorizeTelegramUser } from "./telegram-user-authorization.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function flowError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeBeginInput(input = {}) {
  const apiId = Number(input.apiId);
  const apiHash = String(input.apiHash || "").trim();
  const phoneNumber = String(input.phoneNumber || "").trim();
  if (!Number.isSafeInteger(apiId) || apiId <= 0 || !apiHash || !/^\+[1-9]\d{6,14}$/.test(phoneNumber)) {
    throw flowError("API ID、API Hash 或国际格式手机号无效。", "TELEGRAM_USER_AUTH_INPUT_INVALID");
  }
  return { apiId, apiHash, phoneNumber };
}

function safeAuthorizationError(error) {
  if (String(error?.code || "").startsWith("TELEGRAM_USER_")) return error;
  return flowError("Telegram 拒绝了本次授权，请检查验证码或二次验证密码后重试。", "TELEGRAM_USER_AUTH_REJECTED");
}

export function createTelegramUserWebAuthorization(options = {}) {
  const createClient = options.createClient;
  const store = options.store;
  const id = options.id ?? randomUUID;
  const now = options.now ?? (() => Date.now());
  const ttlMs = Math.max(60_000, Number(options.ttlMs) || 10 * 60_000);
  const flows = new Map();

  if (typeof createClient !== "function") throw new TypeError("createClient is required");
  if (!store || typeof store.save !== "function") throw new TypeError("store is required");

  function getFlow(flowId) {
    const flow = flows.get(String(flowId || ""));
    if (!flow || flow.expiresAt <= now()) {
      if (flow) {
        flows.delete(flow.id);
        flow.submission.reject(flowError("授权已过期。", "TELEGRAM_USER_AUTH_FLOW_EXPIRED"));
        void flow.task?.catch(() => undefined);
        void flow.client?.disconnect?.().catch(() => undefined);
      }
      throw flowError("授权已过期，请重新开始。", "TELEGRAM_USER_AUTH_FLOW_EXPIRED");
    }
    return flow;
  }

  async function begin(input) {
    if ([...flows.values()].some((flow) => flow.expiresAt > now())) {
      throw flowError("已有一项 Telegram 授权正在进行，请先完成或取消。", "TELEGRAM_USER_AUTH_FLOW_ACTIVE");
    }
    const credentials = normalizeBeginInput(input);
    const flow = {
      id: String(id()),
      expiresAt: now() + ttlMs,
      credentials,
      ready: deferred(),
      submission: deferred(),
      client: null,
      codeViaApp: false
    };
    flows.set(flow.id, flow);

    try {
      flow.client = await createClient({ apiId: credentials.apiId, apiHash: credentials.apiHash });
    } catch {
      flows.delete(flow.id);
      throw flowError("无法连接 Telegram 授权服务，请稍后重试。", "TELEGRAM_USER_AUTH_CONNECTION_FAILED");
    }

    flow.task = authorizeTelegramUser({
      client: flow.client,
      store,
      apiCredentials: { apiId: credentials.apiId, apiHash: credentials.apiHash },
      phoneNumber: async () => credentials.phoneNumber,
      phoneCode: async (codeViaApp) => {
        flow.codeViaApp = Boolean(codeViaApp);
        flow.ready.resolve();
        return (await flow.submission.promise).phoneCode;
      },
      password: async () => (await flow.submission.promise).password,
      onError: () => true
    }).catch((error) => {
      flow.ready.reject(safeAuthorizationError(error));
      throw safeAuthorizationError(error);
    });

    try {
      await Promise.race([
        flow.ready.promise,
        flow.task.then(() => {
          throw flowError("Telegram 未请求验证码，授权流程已停止。", "TELEGRAM_USER_AUTH_UNEXPECTED");
        })
      ]);
      return { flowId: flow.id, step: "code", codeViaApp: flow.codeViaApp };
    } catch (error) {
      flows.delete(flow.id);
      await flow.client?.disconnect?.().catch(() => undefined);
      throw safeAuthorizationError(error);
    }
  }

  async function complete(input = {}) {
    const flow = getFlow(input.flowId);
    const phoneCode = String(input.phoneCode || "").replace(/\s+/g, "");
    const password = String(input.password || "");
    if (!/^\d{4,8}$/.test(phoneCode)) {
      throw flowError("Telegram 验证码格式无效。", "TELEGRAM_USER_AUTH_CODE_INVALID");
    }
    flows.delete(flow.id);
    flow.submission.resolve({ phoneCode, password });
    try {
      return await flow.task;
    } catch (error) {
      throw safeAuthorizationError(error);
    } finally {
      await flow.client?.disconnect?.().catch(() => undefined);
    }
  }

  async function cancel(flowId) {
    const flow = flows.get(String(flowId || ""));
    if (!flow) return { cancelled: true };
    flows.delete(flow.id);
    flow.submission.reject(flowError("授权已取消。", "TELEGRAM_USER_AUTH_CANCELLED"));
    void flow.task?.catch(() => undefined);
    await flow.client?.disconnect?.().catch(() => undefined);
    return { cancelled: true };
  }

  function status() {
    const active = [...flows.values()].find((flow) => flow.expiresAt > now());
    return active ? { active: true, step: "code", expiresAt: new Date(active.expiresAt).toISOString() } : { active: false };
  }

  return { begin, complete, cancel, status };
}
