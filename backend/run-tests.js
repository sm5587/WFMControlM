// Run jest programmatically to avoid binary execution issues on Windows/OneDrive
const { runCLI } = require('jest');
const path = require('path');

const projectPath = path.resolve(__dirname);

runCLI(
  {
    runInBand: true,
    noCache: false,
    forceExit: true,
    verbose: true,
    coverage: false,
    testPathPattern: 'tests/unit',
  },
  [projectPath],
).then(({ results }) => {
  console.log('\n=== TEST RESULTS ===');
  console.log(`Total suites:  ${results.numTotalTestSuites}`);
  console.log(`Passed suites: ${results.numPassedTestSuites}`);
  console.log(`Failed suites: ${results.numFailedTestSuites}`);
  console.log(`Total tests:   ${results.numTotalTests}`);
  console.log(`Passed tests:  ${results.numPassedTests}`);
  console.log(`Failed tests:  ${results.numFailedTests}`);
  if (results.numFailedTests > 0) {
    process.exit(1);
  }
}).catch(err => {
  console.error('Jest runner error:', err);
  process.exit(2);
});
