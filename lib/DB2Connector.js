// DB2Connector.js — Nashorn script for JRE 1.8
// Run via: jjs -cp lib/db2jcc4.jar lib/DB2Connector.js -- <action> <client> [sql]
//
// Actions:
//   test   — test connectivity, print server info as JSON
//   query  — run a SELECT, return results as JSON
//   tables — list WFM-related tables as JSON

var DriverManager = Java.type('java.sql.DriverManager');
var System        = Java.type('java.lang.System');
var Class         = Java.type('java.lang.Class');

// ---- helpers ----

function escJson(s) {
    if (!s) return '';
    return String(s).replace(/\\/g,'\\\\').replace(/"/g,'\\"')
                     .replace(/\n/g,'\\n').replace(/\r/g,'\\r').replace(/\t/g,'\\t');
}

function printError(msg) {
    print('{"success":false,"error":"' + escJson(msg) + '"}');
}

// ---- actions ----

function doTest(conn, client, url, connMs) {
    var meta = conn.getMetaData();
    var serverTime = '';
    try {
        var stmt = conn.createStatement();
        var rs = stmt.executeQuery('SELECT CURRENT TIMESTAMP AS TS FROM SYSIBM.SYSDUMMY1');
        if (rs.next()) serverTime = String(rs.getString(1));
        rs.close(); stmt.close();
    } catch(e) {}

    var out = '{';
    out += '"success":true,';
    out += '"client":"'        + escJson(client) + '",';
    out += '"url":"'           + escJson(url) + '",';
    out += '"dbProduct":"'     + escJson(meta.getDatabaseProductName()) + '",';
    out += '"dbVersion":"'     + escJson(meta.getDatabaseProductVersion()) + '",';
    out += '"driverName":"'    + escJson(meta.getDriverName()) + '",';
    out += '"driverVersion":"' + escJson(meta.getDriverVersion()) + '",';
    out += '"serverTime":"'    + escJson(serverTime) + '",';
    out += '"connectionMs":'   + connMs;
    out += '}';
    print(out);
}

function doQuery(conn, sql) {
    var t0 = System.currentTimeMillis();
    var stmt = conn.createStatement();
    var rs = stmt.executeQuery(sql);
    var meta = rs.getMetaData();
    var colCount = meta.getColumnCount();

    var cols = [];
    for (var i = 1; i <= colCount; i++) cols.push(escJson(meta.getColumnLabel(i)));

    var rows = [];
    var rowCount = 0;
    while (rs.next()) {
        var obj = [];
        for (var i = 1; i <= colCount; i++) {
            var val = rs.getString(i);
            obj.push('"' + cols[i-1] + '":' + (val === null ? 'null' : '"' + escJson(val) + '"'));
        }
        rows.push('{' + obj.join(',') + '}');
        rowCount++;
    }
    rs.close(); stmt.close();

    var elapsed = System.currentTimeMillis() - t0;
    var out = '{"success":true,"columns":["' + cols.join('","') + '"],';
    out += '"rows":[' + rows.join(',') + '],';
    out += '"rowCount":' + rowCount + ',';
    out += '"executionMs":' + elapsed + ',';
    out += '"query":"' + escJson(sql) + '"}';
    print(out);
}

function doTables(conn) {
    var sql = "SELECT TABSCHEMA, TABNAME, CARD AS ROW_COUNT " +
              "FROM SYSCAT.TABLES WHERE TYPE = 'T' " +
              "AND (TABNAME LIKE '%JOB%' OR TABNAME LIKE '%BATCH%' " +
              "OR TABNAME LIKE '%SCHEDULE%' OR TABNAME LIKE '%TASK%' " +
              "OR TABNAME LIKE '%WFM%' OR TABNAME LIKE '%CRON%') " +
              "ORDER BY TABSCHEMA, TABNAME FETCH FIRST 100 ROWS ONLY";
    doQuery(conn, sql);
}

// ---- main ----

(function() {
    var args = arguments;
    if (args.length < 2) { printError('Usage: DB2Connector.js <test|query|tables> <CLIENT> [sql]'); quit(1); }

    var action = String(args[0]).toLowerCase();
    var client = String(args[1]).toUpperCase();
    var sql    = args.length > 2 ? String(args[2]) : null;

    // Connection info — populated from env vars injected by the backend (Prisma DB + Keeper)
    var info = { url: '', user: '', pass: '', driver: 'com.ibm.db2.jcc.DB2Driver' };

    // DB2_URL_OVERRIDE  : full JDBC URL  e.g. jdbc:db2://host:50000/RWSDB
    // DB2_USER_OVERRIDE : DB2 username   e.g. rwsuser
    // DB2_PASS_OVERRIDE : DB2 password   (also used by Keeper integration)
    var urlOverride  = System.getenv('DB2_URL_OVERRIDE');
    var userOverride = System.getenv('DB2_USER_OVERRIDE');
    var passOverride = System.getenv('DB2_PASS_OVERRIDE');
    if (urlOverride)  { info.url  = urlOverride; }
    if (userOverride) { info.user = userOverride; }
    if (passOverride) { info.pass = passOverride; }

    if (!info.url || !info.user || !info.pass) {
        printError('Missing connection details for ' + client +
                   '. Ensure DB2 credentials are configured in the database for this client.');
        quit(1);
    }

    Class.forName(info.driver);

    var t0 = System.currentTimeMillis();
    var conn;
    try {
        conn = DriverManager.getConnection(info.url, info.user, info.pass);
    } catch(e) { printError('Connection failed: ' + e); quit(1); }
    var connMs = System.currentTimeMillis() - t0;

    try {
        switch (action) {
            case 'test':   doTest(conn, client, info.url, connMs); break;
            case 'query':
                if (!sql) { printError("SQL required for 'query' action"); quit(1); }
                doQuery(conn, sql);
                break;
            case 'tables': doTables(conn); break;
            default: printError('Unknown action: ' + action); quit(1);
        }
    } catch(e) {
        printError(String(e));
    } finally {
        try { conn.close(); } catch(ignored) {}
    }
}).apply(this, arguments);
