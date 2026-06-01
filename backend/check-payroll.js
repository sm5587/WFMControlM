const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  try {
    const total = await prisma.client.count();
    const payrollEnabled = await prisma.client.count({ where: { payrollEnabled: true } });
    
    console.log(`Total Clients: ${total}`);
    console.log(`Payroll Enabled: ${payrollEnabled}`);
    console.log(`Payroll Disabled: ${total - payrollEnabled}`);
    
    if (payrollEnabled > 0) {
      console.log('\nClients with Payroll Enabled:');
      const clients = await prisma.client.findMany({ 
        where: { payrollEnabled: true },
        select: { clientId: true, name: true }
      });
      clients.forEach(c => console.log(`  - ${c.clientId}: ${c.name}`));
    }
  } catch (e) {
    console.error(e);
  } finally {
    await prisma.$disconnect();
  }
})();
