import java.io.*;
import java.sql.*;

/**
 * DB2 Connector — LEGACY reference only (not used at runtime).
 * The actual connector used is DB2Connector.js (Nashorn/jjs).
 * Connection credentials are passed via environment variables from the backend.
 * 
 * Usage:
 *   java -cp "lib/db2jcc4.jar;lib" DB2Connector <action> <client> [sql]
 * 
 * Actions:
 *   test   — test connectivity, print server info as JSON
 *   query  — execute a SELECT query, return results as JSON
 *   tables — list WFM-related tables as JSON
 * 
 * Output: JSON to stdout (parseable by Node.js)
 */
public class DB2Connector {

    public static void main(String[] args) {
        if (args.length < 2) {
            printError("Usage: DB2Connector <test|query|tables> <CLIENT> [sql]");
            System.exit(1);
        }

        String action = args[0].toLowerCase();
        String client = args[1].toUpperCase();
        String sql = args.length > 2 ? args[2] : null;

        Connection conn = null;
        try {
            // Read connection file
            String connFile = "dbconnections/Production/" + client + "_DBString.txt";
            String[] connInfo = readConnectionFile(connFile);
            String jdbcUrl = connInfo[0];
            String username = connInfo[1];
            String password = connInfo[2];
            String driver = connInfo[3];

            // Load driver
            Class.forName(driver);

            // Connect
            long startMs = System.currentTimeMillis();
            conn = DriverManager.getConnection(jdbcUrl, username, password);
            long connMs = System.currentTimeMillis() - startMs;

            switch (action) {
                case "test":
                    doTest(conn, client, jdbcUrl, connMs);
                    break;
                case "query":
                    if (sql == null || sql.trim().isEmpty()) {
                        printError("SQL query required for 'query' action");
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
            printError(e.getMessage());
            System.exit(1);
        } finally {
            if (conn != null) {
                try { conn.close(); } catch (SQLException ignored) {}
            }
        }
    }

    // ---- Actions ----

    private static void doTest(Connection conn, String client, String url, long connMs) throws SQLException {
        DatabaseMetaData meta = conn.getMetaData();

        // Get server time
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
        System.out.println(sb.toString());
    }

    private static void doQuery(Connection conn, String sql) throws SQLException {
        long startMs = System.currentTimeMillis();
        Statement stmt = conn.createStatement();
        ResultSet rs = stmt.executeQuery(sql);
        ResultSetMetaData meta = rs.getMetaData();
        int colCount = meta.getColumnCount();

        // Columns
        StringBuilder sb = new StringBuilder();
        sb.append("{\"success\":true,\"columns\":[");
        for (int i = 1; i <= colCount; i++) {
            if (i > 1) sb.append(",");
            sb.append("\"").append(escJson(meta.getColumnLabel(i))).append("\"");
        }
        sb.append("],\"rows\":[");

        // Rows
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

        System.out.println(sb.toString());
        rs.close();
        stmt.close();
    }

    private static void doTables(Connection conn) throws SQLException {
        // Find WFM-related tables across all schemas
        String sql = "SELECT TABSCHEMA, TABNAME, CARD AS ROW_COUNT " +
                     "FROM SYSCAT.TABLES WHERE TYPE = 'T' " +
                     "AND (TABNAME LIKE '%JOB%' OR TABNAME LIKE '%BATCH%' " +
                     "OR TABNAME LIKE '%SCHEDULE%' OR TABNAME LIKE '%TASK%' " +
                     "OR TABNAME LIKE '%WFM%' OR TABNAME LIKE '%CRON%') " +
                     "ORDER BY TABSCHEMA, TABNAME FETCH FIRST 100 ROWS ONLY";
        doQuery(conn, sql);
    }

    // ---- Helpers ----

    private static String[] readConnectionFile(String path) throws IOException {
        BufferedReader br = new BufferedReader(new FileReader(path));
        String[] lines = new String[4];
        for (int i = 0; i < 4; i++) {
            String line = br.readLine();
            if (line == null) {
                br.close();
                throw new IOException("Connection file incomplete: " + path);
            }
            lines[i] = line.trim();
        }
        br.close();
        return lines;
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
