import java.sql.*;

/**
 * DB2 Connector — compiled Java JDBC bridge (Java 17+).
 * Connection credentials are passed via environment variables from the backend.
 *
 * Usage:
 *   java -cp "lib/db2jcc4.jar:lib" DB2Connector <action> <client> [sql]
 *
 * Actions:
 *   test   — test connectivity, print server info as JSON
 *   query  — execute a SELECT query, return results as JSON
 *   tables — list WFM-related tables as JSON
 *
 * Output: JSON to stdout (parseable by Node.js)
 */
public class DB2Connector {

    private static final String DEFAULT_DRIVER = "com.ibm.db2.jcc.DB2Driver";

    public static void main(String[] args) {
        if (args.length < 2) {
            printError("Usage: DB2Connector <test|query|tables> <CLIENT> [sql]");
            System.exit(1);
        }

        String action = args[0].toLowerCase();
        String client = args[1].toUpperCase();
        String sql = args.length > 2 ? args[2] : null;

        String jdbcUrl = System.getenv("DB2_URL_OVERRIDE");
        String username = System.getenv("DB2_USER_OVERRIDE");
        String password = System.getenv("DB2_PASS_OVERRIDE");

        if (jdbcUrl == null || jdbcUrl.isBlank()
            || username == null || username.isBlank()
            || password == null || password.isBlank()) {
            printError("Missing connection details for " + client
                + ". Ensure DB2 credentials are configured in the database for this client.");
            System.exit(1);
        }

        Connection conn = null;
        try {
            Class.forName(DEFAULT_DRIVER);

            long startMs = System.currentTimeMillis();
            conn = DriverManager.getConnection(jdbcUrl, username, password);
            long connMs = System.currentTimeMillis() - startMs;

            switch (action) {
                case "test":
                    doTest(conn, client, jdbcUrl, connMs);
                    break;
                case "query":
                    if (sql == null || sql.isBlank()) {
                        printError("SQL required for 'query' action");
                        System.exit(1);
                    }
                    doQuery(conn, sql);
                    break;
                case "tables":
                    doTables(conn);
                    break;
                default:
                    printError("Unknown action: " + action);
                    System.exit(1);
            }
        } catch (Exception e) {
            printError(e.getMessage() != null ? e.getMessage() : String.valueOf(e));
            System.exit(1);
        } finally {
            if (conn != null) {
                try { conn.close(); } catch (SQLException ignored) {}
            }
        }
    }

    private static void doTest(Connection conn, String client, String url, long connMs) throws SQLException {
        DatabaseMetaData meta = conn.getMetaData();

        String serverTime = "";
        try {
            Statement stmt = conn.createStatement();
            ResultSet rs = stmt.executeQuery("SELECT CURRENT TIMESTAMP AS TS FROM SYSIBM.SYSDUMMY1");
            if (rs.next()) serverTime = rs.getString(1);
            rs.close();
            stmt.close();
        } catch (SQLException ignored) {}

        StringBuilder sb = new StringBuilder();
        sb.append("{");
        sb.append("\"success\":true,");
        sb.append("\"client\":\"").append(escJson(client)).append("\",");
        sb.append("\"url\":\"").append(escJson(url)).append("\",");
        sb.append("\"dbProduct\":\"").append(escJson(meta.getDatabaseProductName())).append("\",");
        sb.append("\"dbVersion\":\"").append(escJson(meta.getDatabaseProductVersion())).append("\",");
        sb.append("\"driverName\":\"").append(escJson(meta.getDriverName())).append("\",");
        sb.append("\"driverVersion\":\"").append(escJson(meta.getDriverVersion())).append("\",");
        sb.append("\"serverTime\":\"").append(escJson(serverTime)).append("\",");
        sb.append("\"connectionMs\":").append(connMs);
        sb.append("}");
        System.out.println(sb);
    }

    private static void doQuery(Connection conn, String sql) throws SQLException {
        long startMs = System.currentTimeMillis();
        Statement stmt = conn.createStatement();
        ResultSet rs = stmt.executeQuery(sql);
        ResultSetMetaData meta = rs.getMetaData();
        int colCount = meta.getColumnCount();

        StringBuilder sb = new StringBuilder();
        sb.append("{\"success\":true,\"columns\":[");
        for (int i = 1; i <= colCount; i++) {
            if (i > 1) sb.append(",");
            sb.append("\"").append(escJson(meta.getColumnLabel(i))).append("\"");
        }
        sb.append("],\"rows\":[");

        int rowCount = 0;
        while (rs.next()) {
            if (rowCount > 0) sb.append(",");
            sb.append("{");
            for (int i = 1; i <= colCount; i++) {
                if (i > 1) sb.append(",");
                String colName = meta.getColumnLabel(i);
                String val = rs.getString(i);
                sb.append("\"").append(escJson(colName)).append("\":");
                if (val == null) {
                    sb.append("null");
                } else {
                    sb.append("\"").append(escJson(val)).append("\"");
                }
            }
            sb.append("}");
            rowCount++;
        }

        long elapsed = System.currentTimeMillis() - startMs;
        sb.append("],\"rowCount\":").append(rowCount);
        sb.append(",\"executionMs\":").append(elapsed);
        sb.append(",\"query\":\"").append(escJson(sql)).append("\"");
        sb.append("}");

        System.out.println(sb);
        rs.close();
        stmt.close();
    }

    private static void doTables(Connection conn) throws SQLException {
        String sql = "SELECT TABSCHEMA, TABNAME, CARD AS ROW_COUNT "
            + "FROM SYSCAT.TABLES WHERE TYPE = 'T' "
            + "AND (TABNAME LIKE '%JOB%' OR TABNAME LIKE '%BATCH%' "
            + "OR TABNAME LIKE '%SCHEDULE%' OR TABNAME LIKE '%TASK%' "
            + "OR TABNAME LIKE '%WFM%' OR TABNAME LIKE '%CRON%') "
            + "ORDER BY TABSCHEMA, TABNAME FETCH FIRST 100 ROWS ONLY";
        doQuery(conn, sql);
    }

    private static void printError(String message) {
        System.out.println("{\"success\":false,\"error\":\"" + escJson(message) + "\"}");
    }

    private static String escJson(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
            .replace("\t", "\\t");
    }
}
