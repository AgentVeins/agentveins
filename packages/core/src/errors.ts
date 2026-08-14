export class NotImplementedError extends Error {
  constructor(rail: string) {
    super(`the ${rail} adapter is not implemented yet; only the interface is defined`);
    this.name = "NotImplementedError";
  }
}
