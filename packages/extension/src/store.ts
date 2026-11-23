import { HostListSchema, type HostSetting } from './settings.js';

/** Hosts the user added, in chrome.storage.local. Invalid stored data reads as an empty list. */
export async function loadHosts(): Promise<HostSetting[]> {
  const { hosts } = await chrome.storage.local.get('hosts');
  const parsed = HostListSchema.safeParse(hosts ?? []);
  return parsed.success ? parsed.data : [];
}

export async function saveHosts(hosts: readonly HostSetting[]): Promise<void> {
  await chrome.storage.local.set({ hosts: HostListSchema.parse(hosts) });
}
