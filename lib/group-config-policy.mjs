export function resolveDiscoveredGroups(existingGroups, discoveredGroups) {
  const existing = Array.isArray(existingGroups) ? existingGroups : [];
  const discovered = Array.isArray(discoveredGroups) ? discoveredGroups : [];

  if (!discovered.length && existing.length) {
    return { groups: existing, preservedExisting: true };
  }
  return { groups: discovered, preservedExisting: false };
}
