export function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function delay(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}