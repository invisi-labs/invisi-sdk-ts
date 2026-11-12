import { AsyncLocalStorage } from "node:async_hooks";
export interface Span {
    id: number;
    parent?: number;
    phase: string;
    name: string;
    start: number;
    ms: number;
    ok: boolean;
}
/** Timings retain method names and counters only, never call arguments or wallet contents. */
export class Timing {
    readonly spans: Span[] = [];
    readonly context = new AsyncLocalStorage<{ phase: string; parent?: number }>();
    readonly restores: (() => void)[] = [];
    phase<T>(name: string, work: () => T): T {
        return this.context.run({ phase: name }, () => this.run("total", work));
    }
    run<T>(name: string, work: () => T): T {
        const current = this.context.getStore();
        if (!current) return work();
        const span: Span = {
            id: this.spans.length,
            ...(current.parent === undefined ? {} : { parent: current.parent }),
            phase: current.phase,
            name,
            start: performance.now(),
            ms: 0,
            ok: false,
        };
        this.spans.push(span);
        const end = (ok: boolean) => {
            span.ms = performance.now() - span.start;
            span.ok = ok;
        };
        return this.context.run({ phase: current.phase, parent: span.id }, () => {
            try {
                const value = work();
                if (value && typeof (value as { then?: unknown }).then === "function")
                    return Promise.resolve(value).then(
                        (v) => {
                            end(true);
                            return v;
                        },
                        (e) => {
                            end(false);
                            throw e;
                        }
                    ) as T;
                end(true);
                return value;
            } catch (error) {
                end(false);
                throw error;
            }
        });
    }
    wrap(
        object: object,
        prefix: string,
        names = Object.getOwnPropertyNames(object),
        delayMs = 0
    ): void {
        for (const name of names) {
            const own = Object.getOwnPropertyDescriptor(object, name);
            let descriptor = own;
            for (
                let parent = Object.getPrototypeOf(object) as object | null;
                !descriptor && parent;
                parent = Object.getPrototypeOf(parent) as object | null
            )
                descriptor = Object.getOwnPropertyDescriptor(parent, name);
            if (name === "constructor" || typeof descriptor?.value !== "function") continue;
            const original = descriptor.value,
                timer = this;
            Object.defineProperty(object, name, {
                ...descriptor,
                value: function (this: unknown, ...args: unknown[]) {
                    return timer.run(prefix + "." + name, () =>
                        delayMs
                            ? new Promise((r) => setTimeout(r, delayMs)).then(() =>
                                  original.apply(this, args)
                              )
                            : original.apply(this, args)
                    );
                },
            });
            this.restores.push(() => {
                if (own) Object.defineProperty(object, name, own);
                else Reflect.deleteProperty(object, name);
            });
        }
    }
    restore(): void {
        for (const restore of this.restores.reverse()) restore();
        this.restores.length = 0;
    }
    summary() {
        const phases = [...new Set(this.spans.map((span) => span.phase))];
        return phases.map((phase) => {
            const spans = this.spans.filter((span) => span.phase === phase);
            const calls = Object.fromEntries(
                [...new Set(spans.map((s) => s.name))].map((name) => {
                    const matches = spans.filter((s) => s.name === name);
                    return [
                        name,
                        { count: matches.length, ms: matches.reduce((sum, s) => sum + s.ms, 0) },
                    ];
                })
            );
            return { phase, ms: spans.find((span) => span.name === "total")!.ms, calls };
        });
    }
}
