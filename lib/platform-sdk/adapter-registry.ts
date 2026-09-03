import type { PlatformId } from '../domain/platform';
import { platformRegistry } from '../platforms/registry.ts';
import type { PlatformAdapter, PlatformAdapterDescriptor } from './types';

const knownPlatforms = new Set<PlatformId>(platformRegistry.map((platform) => platform.id));

function descriptor(adapter: PlatformAdapter): PlatformAdapterDescriptor {
  return {
    id: adapter.id,
    name: adapter.name,
    version: adapter.version,
    priority: adapter.priority,
    kind: adapter.kind,
    supports: adapter.supports,
    ruleId: adapter.rules.id,
    ruleVersion: adapter.rules.version,
    fieldCount: adapter.rules.fields.length,
  };
}

export class PlatformAdapterRegistry {
  private readonly adapters = new Map<string, PlatformAdapter>();

  register(adapter: PlatformAdapter): this {
    if (!adapter.id.trim()) throw new Error('Adapter id 不能为空');
    if (this.adapters.has(adapter.id)) throw new Error(`Adapter 已注册：${adapter.id}`);
    if (adapter.supports.length === 0) throw new Error(`Adapter ${adapter.id} 未声明支持平台`);
    for (const platformId of adapter.supports) {
      if (!knownPlatforms.has(platformId)) throw new Error(`Adapter ${adapter.id} 包含未知平台：${platformId}`);
    }
    this.adapters.set(adapter.id, adapter);
    return this;
  }

  resolve(platformId: PlatformId): PlatformAdapter {
    const candidates = [...this.adapters.values()]
      .filter((adapter) => adapter.supports.includes(platformId))
      .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
    const adapter = candidates[0];
    if (!adapter) throw new Error(`平台 ${platformId} 尚无可用 Adapter`);
    return adapter;
  }

  get(adapterId: string): PlatformAdapter | null {
    return this.adapters.get(adapterId) ?? null;
  }

  list(): PlatformAdapterDescriptor[] {
    return [...this.adapters.values()]
      .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))
      .map(descriptor);
  }

  coverage(): Record<PlatformId, string> {
    return Object.fromEntries(platformRegistry.map((platform) => [platform.id, this.resolve(platform.id).id])) as Record<PlatformId, string>;
  }
}
