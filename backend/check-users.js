const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  try {
    const users = await prisma.user.findMany({ 
      select: { id: true, username: true, email: true, isActive: true } 
    });
    console.log('Users in database:');
    users.forEach(u => console.log(`  - ${u.username}: ${u.email} (${u.isActive ? 'active' : 'inactive'})`));
    console.log(`Total: ${users.length}`);
  } catch (e) {
    console.error(e);
  } finally {
    await prisma.$disconnect();
  }
})();
