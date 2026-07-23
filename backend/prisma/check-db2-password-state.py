import sqlite3

DB = r"c:\Users\SM5587\OneDrive - Zebra Technologies\Daily_Work\WFMControlM\backend\prisma\dev.db"
conn = sqlite3.connect(DB)
cur = conn.cursor()
cur.execute("SELECT COUNT(*) FROM Client WHERE db2Password IS NOT NULL AND trim(db2Password) != ''")
total = cur.fetchone()[0]
cur.execute(
    "SELECT clientId, length(db2Password), db2Password FROM Client "
    "WHERE db2Password IS NOT NULL AND trim(db2Password) != '' LIMIT 8"
)
rows = cur.fetchall()
encrypted_guess = 0
plaintext_guess = 0
for client_id, length, pwd in rows:
    looks_enc = length >= 40 and pwd.endswith("=") or (length >= 44 and "+" in pwd or "/" in pwd)
    if looks_enc:
        encrypted_guess += 1
    else:
        plaintext_guess += 1
    print(f"{client_id}: len={length}, sample={pwd[:4]}...")

print(f"totalWithPassword={total}")
print(f"sampleEncryptedGuess={encrypted_guess}, samplePlaintextGuess={plaintext_guess}")
