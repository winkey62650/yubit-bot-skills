function clean(value) {
  return String(value ?? "").trim();
}

export function deploymentEnvironment(env = process.env) {
  const vercelEnvironment = clean(env.VERCEL_ENV).toLowerCase();
  if (["production", "preview", "development"].includes(vercelEnvironment)) {
    return vercelEnvironment;
  }
  return env.NODE_ENV === "production" ? "production" : "development";
}

export function persistentDatabaseConfig(env = process.env) {
  const environment = deploymentEnvironment(env);
  if (environment === "preview" && Boolean(env.VERCEL)) {
    return {
      environment,
      variable: "PREVIEW_DATABASE_URL",
      url: clean(env.PREVIEW_DATABASE_URL),
      isolated: Boolean(clean(env.PREVIEW_DATABASE_URL)),
    };
  }

  const databaseUrl = clean(env.DATABASE_URL);
  const postgresUrl = clean(env.POSTGRES_URL);
  return {
    environment,
    variable: databaseUrl ? "DATABASE_URL" : postgresUrl ? "POSTGRES_URL" : null,
    url: databaseUrl || postgresUrl,
    isolated: environment !== "preview",
  };
}

export function cronSecretConfig(env = process.env) {
  const environment = deploymentEnvironment(env);
  if (environment === "preview" && Boolean(env.VERCEL)) {
    const secret = clean(env.PREVIEW_CRON_SECRET);
    return {
      environment,
      variable: "PREVIEW_CRON_SECRET",
      secret,
      isolated: Boolean(secret),
    };
  }

  const secret = clean(env.CRON_SECRET);
  return {
    environment,
    variable: "CRON_SECRET",
    secret,
    isolated: environment !== "preview",
  };
}

export function missingDatabaseMessage(label, env = process.env) {
  const config = persistentDatabaseConfig(env);
  if (config.environment === "preview" && Boolean(env.VERCEL)) {
    return `${label}预览数据库未配置：请设置 PREVIEW_DATABASE_URL；禁止复用生产数据库 DATABASE_URL`;
  }
  return `${label}数据库未配置：请设置 DATABASE_URL`;
}
