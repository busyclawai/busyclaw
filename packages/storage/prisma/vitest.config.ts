import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		// ONE PHYSICAL DATABASE, so one file at a time.
		//
		// `schema.prisma` points every suite in this package at the same `file:./test.db`, and the
		// suites clean up by blanket-wiping their tables between cases. Run two files concurrently and
		// they delete each other's rows mid-test, which surfaces as whichever assertions happened to be
		// mid-flight — a different set on every run, none of them about the code under test.
		//
		// The constraint is the datasource's, not the tests': a generated Prisma client is bound to the
		// URL it was generated against, so there is no per-worker database to hand out. Serialising the
		// files is the honest way to say that, and it costs a few seconds in the one package that has
		// to pay it.
		fileParallelism: false,
	},
});
