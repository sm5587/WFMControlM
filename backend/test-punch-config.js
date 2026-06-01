const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  try {
    console.log('[TEST] Checking unprocessed punch data availability...\n');
    
    // Get RTA clients
    const rtaClients = await prisma.client.findMany({
      where: { payrollEnabled: true },
      select: { clientId: true, name: true, db2Host: true, db2Port: true, db2Database: true }
    });
    
    console.log(`✓ Found ${rtaClients.length} RTA-enabled clients\n`);
    
    if (rtaClients.length === 0) {
      console.log('✗ NO RTA CLIENTS - This is the problem!');
      process.exit(1);
    }
    
    // Sample check on first 3 clients
    console.log('Checking database connectivity for first 3 clients:\n');
    for (const client of rtaClients.slice(0, 3)) {
      console.log(`${client.clientId} (${client.name}):`);
      console.log(`  Host: ${client.db2Host || 'NOT SET'}`);
      console.log(`  Port: ${client.db2Port || 'NOT SET'}`);
      console.log(`  Database: ${client.db2Database || 'NOT SET'}`);
      
      if (!client.db2Host || !client.db2Database) {
        console.log(`  ⚠ MISSING CONFIG - Won't be able to query this client!`);
      }
      console.log();
    }
    
    console.log(`\n[SUMMARY]`);
    console.log(`Total RTA clients: ${rtaClients.length}`);
    
    // Check if any client has DB2 config
    const configuredClients = rtaClients.filter(c => c.db2Host && c.db2Database);
    console.log(`Configured (with DB2 host+database): ${configuredClients.length}`);
    
    if (configuredClients.length === 0) {
      console.log(`\n✗ PROBLEM IDENTIFIED: No clients have DB2 configuration!`);
      console.log('   Even though payrollEnabled=true, no DB2 connection details are set.');
      console.log('   The punch query endpoint will return empty results.');
    } else {
      console.log(`\n✓ At least ${configuredClients.length} clients have DB2 configuration`);
      console.log('  Punch queries should return data (if unproc records exist)');
    }
    
  } catch (e) {
    console.error('✗ Error:', e.message);
  } finally {
    await prisma.$disconnect();
  }
})();
