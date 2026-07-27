import assert from "node:assert/strict";
import { test } from "node:test";

import { findNativeScrollContractViolations } from "./check-mission-control-next-scroll-contracts.mjs";

test("rejects default-bounded collections inside scrollBody cards", () => {
  const violations = findNativeScrollContractViolations(
    "SettingsSection.tsx",
    `
      <NativeCard title="Catalog" subtitle="Items" scrollBody bodyMaxHeight="20rem">
        <SettingsActionList items={items} />
      </NativeCard>
    `,
  );

  assert.equal(violations.length, 1);
  assert.deepEqual(violations[0].boundedDescendants, ["SettingsActionList"]);
});

test("rejects explicitly bounded NativeList inside scrollBody cards", () => {
  const violations = findNativeScrollContractViolations(
    "RuntimeSection.tsx",
    `
      <NativeCard title="Evidence" subtitle="Items" scrollBody>
        <NativeList items={items} maxHeight="18rem" />
      </NativeCard>
    `,
  );

  assert.equal(violations.length, 1);
  assert.deepEqual(violations[0].boundedDescendants, ["NativeList"]);
});

test("allows standalone card scrolling and explicitly unbounded inner collections", () => {
  const violations = findNativeScrollContractViolations(
    "Allowed.tsx",
    `
      <>
        <NativeCard title="Editor" subtitle="Large content" scrollBody bodyMaxHeight="30rem">
          <Editor />
        </NativeCard>
        <NativeCard title="Catalog" subtitle="Items" scrollBody>
          <NativeSelectableList items={items} maxHeight="" />
          <NativeList items={items} />
        </NativeCard>
      </>
    `,
  );

  assert.deepEqual(violations, []);
});

test("allows disabled scrollBody declarations", () => {
  const violations = findNativeScrollContractViolations(
    "Disabled.tsx",
    `
      <NativeCard title="Catalog" subtitle="Items" scrollBody={false}>
        <NativeSelectableList items={items} />
      </NativeCard>
    `,
  );

  assert.deepEqual(violations, []);
});
