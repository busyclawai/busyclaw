import { type Adapter, memoryAdapter } from "@euroclaw/storage-core";
import { kyselyAdapter } from "@euroclaw/storage-kysely";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { createTeamStore } from "../src/team";

function suite(
	name: string,
	makeAdapter: () => Adapter,
	teardown?: () => void,
): void {
	describe(`createTeamStore over ${name}`, () => {
		afterEach(() => teardown?.());

		it("invite → accept (single-use) → member with the invited role", async () => {
			const store = createTeamStore(makeAdapter());
			const invite = await store.invite({
				team: "acme",
				email: "bob@x.com",
				role: "approver",
			});
			expect(invite.id).toMatch(/^[0-9a-f]{32}$/);
			expect(await store.roleOf("acme", "bob")).toBeNull(); // not a member until accepted
			const member = await store.accept(invite.id, "bob");
			expect(member).toMatchObject({
				team: "acme",
				userId: "bob",
				role: "approver",
			});
			expect(await store.roleOf("acme", "bob")).toBe("approver");
			expect(await store.accept(invite.id, "bob")).toBeNull(); // single-use: the invite is consumed
		});

		it("members lists the team; remove revokes access", async () => {
			const store = createTeamStore(makeAdapter());
			for (const [email, user, role] of [
				["a@x", "alice", "operator"],
				["b@x", "bob", "approver"],
			] as const) {
				const inv = await store.invite({ team: "acme", email, role });
				await store.accept(inv.id, user);
			}
			expect((await store.members("acme")).map((m) => m.userId).sort()).toEqual(
				["alice", "bob"],
			);
			await store.remove("acme", "alice");
			expect(await store.roleOf("acme", "alice")).toBeNull();
			expect(await store.roleOf("acme", "bob")).toBe("approver");
		});

		it("roleOf is null for a non-member or the wrong team", async () => {
			const store = createTeamStore(makeAdapter());
			const inv = await store.invite({
				team: "acme",
				email: "b@x",
				role: "approver",
			});
			await store.accept(inv.id, "bob");
			expect(await store.roleOf("acme", "stranger")).toBeNull();
			expect(await store.roleOf("other", "bob")).toBeNull();
		});

		it("rejects a corrupt member row instead of trusting it for authz", async () => {
			const adapter = makeAdapter();
			const store = createTeamStore(adapter);
			// Plant a row missing the required `role` — exactly what the old blind cast would have
			// handed straight to roleOf/authz. Validation must reject it on read.
			await adapter.create({
				model: "team_member",
				data: {
					id: "m1",
					team: "acme",
					userId: "bob",
					joinedAt: "2026-01-01T00:00:00.000Z",
				},
			});
			await expect(store.roleOf("acme", "bob")).rejects.toThrow(
				/team_member record invalid/,
			);
			await expect(store.members("acme")).rejects.toThrow(
				/team_member record invalid/,
			);
		});
	});
}

suite("memory adapter", () => memoryAdapter());

let sqlite: Database.Database;
suite(
	"kysely (sqlite)",
	() => {
		sqlite = new Database(":memory:");
		const db = new Kysely<Record<string, Record<string, unknown>>>({
			dialect: new SqliteDialect({ database: sqlite }),
		});
		// The tables `euroclaw generate` will emit from teamSchema.
		sqlite.exec(
			`CREATE TABLE team_member (id TEXT PRIMARY KEY, team TEXT, userId TEXT, role TEXT, joinedAt TEXT)`,
		);
		sqlite.exec(
			`CREATE TABLE team_invite (id TEXT PRIMARY KEY, team TEXT, email TEXT, role TEXT, createdAt TEXT)`,
		);
		return kyselyAdapter(db);
	},
	() => sqlite?.close(),
);
