export function toBytes32(value: number): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}
