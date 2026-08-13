export const ROLES = Object.freeze({
  ADMIN: "admin",
  MANUAL_PUBLISHER: "manual_publisher"
});

export const HOME_BY_ROLE = Object.freeze({
  admin: "/group-config",
  manual_publisher: "/composer"
});

const MANUAL_PAGE_ACCESS = new Set(["/composer", "/telegram-user-authorization"]);
const MANUAL_API_ACCESS = new Map([
  ["/api/auth/session", new Set(["GET"])],
  ["/api/auth/logout", new Set(["POST"])],
  ["/api/composer/send", new Set(["POST"])],
  ["/api/group-config", new Set(["GET"])],
  ["/api/telegram/dialogs", new Set(["GET"])],
  ["/api/telegram/user-authorization", new Set(["GET"])]
]);

export function normalizeRole(role, { legacy = false } = {}) {
  if (role === ROLES.ADMIN || role === ROLES.MANUAL_PUBLISHER) return role;
  return legacy && !role ? ROLES.ADMIN : null;
}

export function canAccessPath(role, pathname, method = "GET") {
  if (role === ROLES.ADMIN) return true;
  if (role !== ROLES.MANUAL_PUBLISHER) return false;
  if (pathname.startsWith("/api/")) {
    return MANUAL_API_ACCESS.get(pathname)?.has(String(method).toUpperCase()) === true;
  }
  return MANUAL_PAGE_ACCESS.has(pathname);
}

export function canQueueComposerMessage(role) {
  return role === ROLES.ADMIN;
}

export function filterNavigationForRole(items, role) {
  return items.flatMap((item) => {
    if (item.roles && !item.roles.includes(role)) return [];
    if (!Array.isArray(item.items)) return [item];

    const visibleItems = filterNavigationForRole(item.items, role);
    return visibleItems.length > 0 ? [{ ...item, items: visibleItems }] : [];
  });
}
