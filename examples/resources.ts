/** Cleanup registration supplied by the command-line runner. */
export interface ExampleResources {
    defer(cleanup: () => void | Promise<void>): void;
}
