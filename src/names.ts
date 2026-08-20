export class UniqueNameAllocator {
  private readonly allocated = new Set<string>();
  private readonly nextSuffix = new Map<string, number>();

  allocate(requestedName: string): string {
    const base = requestedName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

    if (!base) {
      throw new Error("Agent names must contain a letter or number.");
    }

    if (!this.allocated.has(base)) {
      this.allocated.add(base);
      this.nextSuffix.set(base, 2);
      return base;
    }

    let suffix = this.nextSuffix.get(base) ?? 2;
    let candidate = `${base}-${suffix}`;
    while (this.allocated.has(candidate)) {
      suffix += 1;
      candidate = `${base}-${suffix}`;
    }

    this.allocated.add(candidate);
    this.nextSuffix.set(base, suffix + 1);
    return candidate;
  }
}
