# SaRa FOB Work Order Desk

Fresh standalone application. It does **not** import or connect to any previous work-order application or database.

## Features
- Username/password login with `admin`, `editor`, and `viewer` roles
- Work orders with multiple style-wise rows, quantity, unit cost, automatic line totals and totals
- Supplier directory
- Search and archive for new work orders
- Print-friendly work-order document; use the browser's **Save as PDF** option
- Excel (.xlsx) export
- Work-order status and approval/signature lines
- Responsive black-and-white corporate UI
- PostgreSQL-backed storage

## Deploy to a new GitHub repository and Render service
1. Create a **new empty GitHub repository** (do not reuse the old repository).
2. Upload/push all files in this folder to the repository root.
3. Create a **new PostgreSQL database** in Neon. Copy its pooled or direct connection string and ensure SSL is enabled.
4. In Render, create a new Web Service from the new repository. Set:
   - `DATABASE_URL`: the connection string for the **new** Neon database
   - `SESSION_SECRET`: a unique random string with at least 32 characters
   - `ADMIN_USERNAME`: initial administrator username
   - `ADMIN_PASSWORD`: a strong unique password
   - `NODE_ENV`: `production`
5. Deploy. Visit `/api/health` to check database connectivity.

The server creates the required tables automatically. It never drops tables or migrates data from another database. **Use a new empty database URL only.**
For stronger operations, create editor accounts from the Users section after logging in as admin. Do not share secrets in chat or commit `.env`.

## User management
The first admin account is provisioned from the environment variables on startup if the username does not already exist. Log in with those credentials, then create users under **Users**. Viewer accounts can read and export; editor accounts can create and update work orders and suppliers; admin accounts can also manage users and archive work orders.

## Local development
```bash
npm install
cp .env.example .env
# Edit .env and use a PostgreSQL database dedicated to development.
npm start
```
