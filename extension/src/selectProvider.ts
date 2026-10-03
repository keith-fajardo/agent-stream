import type { ProviderId, ProviderStatus } from '@agent-stream/shared';

type Choice = { id: ProviderId | 'recheck'; label: string; description?: string; detail?: string };
export type SelectProviderDeps = {
  providers: { id: ProviderId; name: string; status(): Promise<ProviderStatus> }[];
  current(): ProviderId;
  pick(items: Choice[], placeholder: string): Promise<Choice | undefined>;
  write(id: ProviderId): Promise<void>;
  recheck(): Promise<unknown>;
};

export async function selectProvider(d: SelectProviderDeps): Promise<void> {
  const current = d.current();
  const items: Choice[] = await Promise.all(
    d.providers.map(async (p) => {
      const s = await p.status();
      const detail = s.ok ? s.detail : (s.detail ?? s.error);
      return { id: p.id, label: `${p.id === current ? '$(check) ' : ''}${p.name}`, description: s.label, ...(detail !== undefined && { detail }) };
    }),
  );
  items.push({ id: 'recheck', label: '$(refresh) Check again' });
  const choice = await d.pick(items, 'Choose the AI provider Agent Stream runs on');
  if (!choice) return;
  if (choice.id === 'recheck' || choice.id === current) {
    await d.recheck();
    return;
  }
  await d.write(choice.id); // the configuration change triggers checkProvider
}
