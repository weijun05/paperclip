import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companies, companySkills, createDb, folders } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companySkillService } from "../services/company-skills.ts";

// A fake GitHub served entirely from memory. `ghFetch` is the single network
// seam the importer goes through, so stubbing it covers both the tree listing
// and the raw file reads without touching the network.
const remote = vi.hoisted(() => ({
  blobs: new Map<string, string>(),
}));

vi.mock("../services/github-fetch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/github-fetch.js")>();
  return {
    ...actual,
    ghFetch: async (url: string) => {
      if (url.includes("/git/trees/")) {
        return new Response(
          JSON.stringify({
            tree: Array.from(remote.blobs.keys(), (entryPath) => ({ path: entryPath, type: "blob" })),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      // raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>
      const rawMatch = url.match(/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\/(.+)$/);
      const blob = rawMatch ? remote.blobs.get(rawMatch[1]!) : undefined;
      return blob === undefined
        ? new Response("Not Found", { status: 404 })
        : new Response(blob, { status: 200 });
    },
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres GitHub skill import tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// A 40-hex ref makes resolveGitHubPinnedRef short-circuit, so the import issues
// exactly one tree request and then raw reads — no default-branch lookup.
const SHA = "0123456789abcdef0123456789abcdef01234567";
const REPO = `https://github.com/acme/skillpack/tree/${SHA}`;

function skillMarkdown(name: string) {
  return `---\nname: ${name}\ndescription: ${name} skill\n---\n\n# ${name}\n`;
}

describeEmbeddedPostgres("companySkillService GitHub import inventory", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof companySkillService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let oldPaperclipHome: string | undefined;
  let oldPaperclipInstanceId: string | undefined;
  let paperclipHome: string | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-gh-skill-import-");
    oldPaperclipHome = process.env.PAPERCLIP_HOME;
    oldPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-gh-skill-import-home-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "default";
    db = createDb(tempDb.connectionString);
    svc = companySkillService(db);
  }, 20_000);

  beforeEach(() => {
    remote.blobs.clear();
    // Root SKILL.md alongside two skill subdirectories: the shape that makes the
    // repo-root case distinguishable from the scoped-directory case.
    remote.blobs.set("SKILL.md", skillMarkdown("root-skill"));
    remote.blobs.set("review/SKILL.md", skillMarkdown("review"));
    remote.blobs.set("review/checklist.md", "# Checklist\n");
    remote.blobs.set("review/design-checklist.md", "# Design checklist\n");
    remote.blobs.set("review/nested/extra.md", "# Extra\n");
    remote.blobs.set("qa/SKILL.md", skillMarkdown("qa"));
    remote.blobs.set("qa/templates/report.md", "# Report\n");
  });

  afterEach(async () => {
    await db.delete(companySkills);
    await db.delete(folders);
    await db.delete(companies);
  });

  afterAll(async () => {
    if (oldPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = oldPaperclipHome;
    if (oldPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = oldPaperclipInstanceId;
    if (paperclipHome) await fs.rm(paperclipHome, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  async function createCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  function inventoryPaths(skill: { fileInventory: Array<{ path: string }> }) {
    return skill.fileInventory.map((entry) => entry.path).sort();
  }

  it("collects sibling files when the URL points at the skill directory itself", async () => {
    // The regression: path.posix.dirname("SKILL.md") is ".", and "./" as a prefix
    // matched nothing, so the inventory collapsed to SKILL.md and every companion
    // file the skill reads at runtime silently disappeared.
    const companyId = await createCompany();
    const result = await svc.importFromSource(companyId, `${REPO}/review`);

    expect(result.imported).toHaveLength(1);
    const skill = result.imported[0]!;
    expect(skill.slug).toBe("review");
    expect(inventoryPaths(skill)).toEqual([
      "SKILL.md",
      "checklist.md",
      "design-checklist.md",
      "nested/extra.md",
    ]);
  });

  it("produces the same inventory whether scoped to the directory or selected from the repo root", async () => {
    // Both spellings address one skill, so they must agree. Repo-root + --skill
    // was the only working spelling before the fix.
    const scopedCompanyId = await createCompany();
    const scoped = await svc.importFromSource(scopedCompanyId, `${REPO}/review`);

    const rootCompanyId = await createCompany();
    const fromRoot = await svc.importFromSource(rootCompanyId, `npx skills add ${REPO} --skill=review`);

    expect(inventoryPaths(fromRoot.imported[0]!)).toEqual(inventoryPaths(scoped.imported[0]!));
  });

  it("does not swallow the whole repository for a repo-root SKILL.md", async () => {
    // A root-level SKILL.md also yields skillDir ".", but nothing narrowed the
    // tree, so its "siblings" would be every file in the repo — including the
    // other skills. This case must stay SKILL.md-only.
    const companyId = await createCompany();
    const result = await svc.importFromSource(companyId, `npx skills add ${REPO} --skill=root-skill`);

    const skill = result.imported.find((entry) => entry.slug === "root-skill");
    expect(skill).toBeDefined();
    expect(inventoryPaths(skill!)).toEqual(["SKILL.md"]);
  });
});
