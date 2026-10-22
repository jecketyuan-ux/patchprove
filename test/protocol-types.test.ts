import { describe, expectTypeOf, it } from "vitest";
import type { EvidenceWire, EvidenceV2Wire, EvidenceV2RequiredFields } from "../src/generated/evidence.js";
import type { ReceiptWire, ReceiptV2Wire, ReceiptV2RequiredFields } from "../src/generated/receipt.js";
import type { analyze } from "../src/run.js";
import type { buildReceipt } from "../src/receipt.js";
import type { Evidence, EvidenceReceipt } from "../src/types.js";

type DeclaredProperties<T> = {
  [Key in keyof T as string extends Key ? never : number extends Key ? never : Key]: T[Key];
};
type KnownProperties<T> = keyof DeclaredProperties<T> extends never
  ? string extends keyof T ? Record<string, T[string]> : T
  : DeclaredProperties<T>;

/** Compare known JSON field values; historical optionality and additive maps remain reader concerns. */
type FieldShape<T> = T extends readonly (infer Item)[] ? FieldShape<Item>[] : T extends object
  ? { [Key in keyof KnownProperties<T>]-?: FieldShape<Exclude<KnownProperties<T>[Key], undefined>> }
  : T;
type KnownWire<T> = T extends readonly (infer Item)[] ? KnownWire<Item>[] : T extends object
  ? { [Key in keyof KnownProperties<T>]: KnownWire<KnownProperties<T>[Key]> }
  : T;
type RequiredKeys<T> = { [Key in keyof T]-?: {} extends Pick<T, Key> ? never : Key }[keyof T];

describe("schema-generated protocol compatibility", () => {
  it("keeps every known evidence and receipt field aligned with the domain model", () => {
    expectTypeOf<FieldShape<Evidence>>().toEqualTypeOf<FieldShape<EvidenceWire>>();
    expectTypeOf<FieldShape<EvidenceReceipt>>().toEqualTypeOf<FieldShape<ReceiptWire>>();
  });

  it("accepts the actual domain producer return types as schema wire shapes", () => {
    expectTypeOf<Awaited<ReturnType<typeof analyze>>>().toExtend<KnownWire<EvidenceWire>>();
    expectTypeOf<ReturnType<typeof buildReceipt>>().toExtend<KnownWire<ReceiptWire>>();
  });

  it("requires each protocol-2 conditional field and narrows the protocol versions", () => {
    expectTypeOf<EvidenceV2RequiredFields>().toExtend<RequiredKeys<EvidenceV2Wire>>();
    expectTypeOf<ReceiptV2RequiredFields>().toExtend<RequiredKeys<ReceiptV2Wire>>();
    expectTypeOf<EvidenceV2Wire["snapshot"]>().toEqualTypeOf<NonNullable<EvidenceWire["snapshot"]>>();
    expectTypeOf<ReceiptV2Wire["effectivePolicy"]>().toEqualTypeOf<NonNullable<ReceiptWire["effectivePolicy"]>>();
    expectTypeOf<EvidenceV2Wire["schemaVersion"]>().toEqualTypeOf<`2.${number}.${number}`>();
    expectTypeOf<ReceiptV2Wire["schemaVersion"]>().toEqualTypeOf<"2.0.0">();
    expectTypeOf<ReceiptV2Wire["evidenceSchemaVersion"]>().toEqualTypeOf<`2.${number}.${number}`>();
  });
});
