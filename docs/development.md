# Development

## Dev server

Start the local server yourself:

```powershell
npm run dev
```

Defaults used by `src/dev-server.ts`:

- URL: `http://127.0.0.1:3000`
- Login password: `admin`
- Config/database: `.local/dev-config`
- Downloads: `data/downloads`
- Log level: `info`

Override a default in PowerShell when needed:

```powershell
$env:PORT='3001'
npm run dev
```

Production startup stays separate:

```powershell
npm run build
npm start
```
