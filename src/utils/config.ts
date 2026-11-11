const SITE_SETTINGS = {
  email: {
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    host: process.env.EMAIL_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.EMAIL_PORT || '587'),
    secure: process.env.EMAIL_PORT === '465',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASSWORD,
    },
    tls: {
      rejectUnauthorized: false,
    },
    debug: false,
    logger: false,
  },
  fromMail: process.env.EMAIL_FROM || process.env.EMAIL_USER,
};
export default SITE_SETTINGS;

export const DEFAULT_STORE_SEARCH_RADIUS_KM = 15;

/**
 * The shared store eligibility radius (km) — every store-distance rule
 * (StoreAssignmentService) and GET /rider/stores/nearby. Read from
 * STORE_SEARCH_RADIUS_KM, so an env change plus a reload/restart applies it.
 * Unset → 15; any other value must be a finite positive number or this
 * throws (checked at startup in application.ts). STORE_ASSIGNMENT_RADIUS_KM,
 * the setting's old name, is still read when the new one is unset.
 */
export function storeSearchRadiusKm(env: NodeJS.ProcessEnv = process.env): number {
  const [name, raw] = (['STORE_SEARCH_RADIUS_KM', 'STORE_ASSIGNMENT_RADIUS_KM'] as const)
    .map(key => [key, env[key]?.trim()] as const)
    .find(([, value]) => value) ?? [];
  if (!name || !raw) return DEFAULT_STORE_SEARCH_RADIUS_KM;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a finite positive number of kilometres; got "${raw}".`);
  }
  return value;
}
