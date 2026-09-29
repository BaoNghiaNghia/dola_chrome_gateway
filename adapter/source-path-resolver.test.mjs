import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseUniqueSourcePath,
  createSessionDestinationRouter,
} from "./source-path-resolver.mjs";

const file = {
  name: "reference.png",
  size: 123456,
  lastModified: 1_790_000_000_123,
};

test("resolves one exact dropped-file metadata match", () => {
  const result = chooseUniqueSourcePath(file, [
    {
      path: "D:\\Campaign\\reference.png",
      size: 123456,
      lastModified: 1_790_000_000_123,
    },
    {
      path: "E:\\Other\\reference.png",
      size: 999,
      lastModified: 1_790_000_000_123,
    },
  ]);
  assert.equal(result, "D:\\Campaign\\reference.png");
});

test("allows small filesystem timestamp precision differences", () => {
  const result = chooseUniqueSourcePath(file, [
    {
      path: "D:\\Campaign\\reference.png",
      size: 123456,
      lastModified: file.lastModified + 1500,
    },
  ]);
  assert.equal(result, "D:\\Campaign\\reference.png");
});

test("refuses ambiguous metadata matches instead of guessing a folder", () => {
  const result = chooseUniqueSourcePath(file, [
    {
      path: "D:\\CampaignA\\reference.png",
      size: 123456,
      lastModified: file.lastModified,
    },
    {
      path: "E:\\CampaignB\\reference.png",
      size: 123456,
      lastModified: file.lastModified,
    },
  ]);
  assert.equal(result, null);
});

test("refuses mismatched size or modification time", () => {
  const result = chooseUniqueSourcePath(file, [
    {
      path: "D:\\Campaign\\reference.png",
      size: 123457,
      lastModified: file.lastModified,
    },
    {
      path: "E:\\Campaign\\reference.png",
      size: 123456,
      lastModified: file.lastModified + 30_000,
    },
  ]);
  assert.equal(result, null);
});


test("first source path wins for the whole profile session", () => {
  const router = createSessionDestinationRouter("E:\\Dola Chrome\\Downloads");
  assert.equal(router.lock("D:\\CampaignA\\first.png"), true);
  assert.equal(router.primarySourcePath, "D:\\CampaignA\\first.png");
  assert.equal(router.outputDir, "D:\\CampaignA");

  assert.equal(router.lock("E:\\CampaignB\\second.png"), false);
  assert.equal(router.primarySourcePath, "D:\\CampaignA\\first.png");
  assert.equal(router.outputDir, "D:\\CampaignA");
});

test("unresolved first drop locks the session to fallback", () => {
  const router = createSessionDestinationRouter("E:\\Dola Chrome\\Downloads");
  assert.equal(router.lock(null), false);
  assert.equal(router.locked, true);
  assert.equal(router.primarySourcePath, null);
  assert.equal(router.outputDir, "E:\\Dola Chrome\\Downloads");

  assert.equal(router.lock("D:\\Later\\second.png"), false);
  assert.equal(router.outputDir, "E:\\Dola Chrome\\Downloads");
});
