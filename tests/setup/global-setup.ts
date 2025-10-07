import path from 'node:path'
import { execaCommand } from 'execa'
import fsExtra from 'fs-extra'
import 'dotenv/config'
import '#app/utils/env.server.ts'
import '#app/utils/cache.server.ts'

export const BASE_DATABASE_PATH = path.join(
	process.cwd(),
	`./tests/prisma/base.db`,
)

export async function setup() {
	const databaseExists = await fsExtra.pathExists(BASE_DATABASE_PATH)

  // Always rebuild base.db to ensure latest migrations & triggers (fast for SQLite, avoids drift)
  if (databaseExists) {
    await fsExtra.remove(BASE_DATABASE_PATH)
  }

	await execaCommand(
		'npx prisma migrate reset --force --skip-seed --skip-generate',
		{
			stdio: 'inherit',
			env: {
				...process.env,
				DATABASE_URL: `file:${BASE_DATABASE_PATH}`,
			},
		},
	)
}
