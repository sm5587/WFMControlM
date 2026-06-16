const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

/** Split SQL on semicolons outside of single-quoted strings ('' = escaped quote). */
function splitSqlStatements(sqlText) {
  const withoutLineComments = sqlText
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

  const statements = [];
  let current = '';
  let inString = false;

  for (let i = 0; i < withoutLineComments.length; i++) {
    const ch = withoutLineComments[i];
    if (ch === "'") {
      current += ch;
      if (inString && withoutLineComments[i + 1] === "'") {
        current += "'";
        i += 1;
        continue;
      }
      inString = !inString;
      continue;
    }
    if (ch === ';' && !inString) {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = '';
      continue;
    }
    current += ch;
  }

  const trimmed = current.trim();
  if (trimmed) statements.push(trimmed);
  return statements;
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('Usage: node scripts/apply-sql.js <sql-file-path>');
    process.exit(1);
  }

  const absolutePath = path.resolve(process.cwd(), inputPath);
  if (!fs.existsSync(absolutePath)) {
    console.error(`[SQL] File not found: ${absolutePath}`);
    process.exit(1);
  }

  const sqlText = fs.readFileSync(absolutePath, 'utf8');
  const statements = splitSqlStatements(sqlText);

  if (statements.length === 0) {
    console.log(`[SQL] No executable statements in ${absolutePath}`);
    return;
  }

  const prisma = new PrismaClient();
  try {
    for (let i = 0; i < statements.length; i += 1) {
      const stmt = statements[i];
      await prisma.$executeRawUnsafe(stmt);
      console.log(`[SQL] Applied statement ${i + 1}/${statements.length}`);
    }
    console.log(`[SQL] Completed: ${absolutePath}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[SQL] Failed:', err?.message || err);
  process.exit(1);
});
