function normalized(value) {
  return String(value ?? "").trim().toUpperCase();
}

export function shouldCloseTopicAfterSetup(topic = {}) {
  const name = normalized(topic?.name);
  return Number(topic?.id) === 1 || name.includes("READ FIRST") || name.includes("DISCLAIMER");
}
