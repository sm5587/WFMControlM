const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  try {
    const password = 'wfmadmin2026';
    const hash = await bcrypt.hash(password, 10);
    
    const updated = await prisma.user.update({
      where: { username: 'admin' },
      data: { passwordHash: hash }
    });
    
    console.log(`✓ Updated admin password hash`);
    console.log(`  Username: ${updated.username}`);
    console.log(`  Email: ${updated.email}`);
    console.log(`  Password: wfmadmin2026`);
  } catch (e) {
    console.error('Error:', e.message);
  } finally {
    await prisma.$disconnect();
  }
})();
