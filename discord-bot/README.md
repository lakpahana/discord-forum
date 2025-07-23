## Configuration

### Environment Variables

| Variable | Description | Required | Example |
|----------|-------------|----------|---------|
| `DISCORD_TOKEN` | Discord bot token | Yes | `your_bot_token` |
| `DISCORD_GUILD_ID` | Guild ID for dev commands | No | `123456789012345678` |
| `MYSQL_HOST` | MySQL host | Yes | `localhost` |
| `MYSQL_USER` | MySQL username | Yes | `root` |
| `MYSQL_PASSWORD` | MySQL password | Yes | `password` |
| `MYSQL_DATABASE` | Database name | Yes | `forum` |
| `PII_PEPPER` | 256-bit hex string for hashing | Yes | `64_character_hex_string` |
| `AWS_ACCESS_KEY_ID` | AWS access key | Yes | `AKIAIOSFODNN7EXAMPLE` |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key | Yes | `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY` |
| `S3_BUCKET` | S3 bucket name | Yes | `forum-assets` |
| `S3_REGION` | AWS region | Yes | `us-east-1` |
| `ADMIN_CREDS` | Basic auth credentials | Yes | `admin:secretpassword` |
| `STAFF_CSV_PATH` | Optional staff CSV file | No | `staff.csv` |
| `IMAGE_MAX_MB` | Max image size in MB | No | `10` |
| `IMAGE_MAX_W` | Max image width | No | `1920` |
| `IMAGE_MAX_H` | Max image height | No | `1080` |
| `NODE_ENV` | Environment | No | `production` |
| `PORT` | HTTP port | No | `3000` |

### Historical Sync Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `ENABLE_HISTORICAL_SYNC` | Enable smart sync on startup | `true` |
| `FORCE_FULL_SYNC` | Force full sync instead of smart delta | `false` |
| `SYNC_GUILD_ID` | Guild to sync (legacy, for old sync only) | `123456789012345678` |
| `SYNC_CHANNEL_ID` | Channel to sync (legacy, for old sync only) | `987654321098765432` |
| `SYNC_THREAD_ID` | Thread to sync (legacy, for old sync only) | `111222333444555666` |
| `SYNC_LIMIT` | Max threads to process (legacy, for old sync only) | `100` |
| `SYNC_SKIP_EXISTING` | Skip existing content (legacy, for old sync only) | `true` |

### Run Mode Configuration

| Variable | Description | Default | Example |
|----------|-------------|---------|---------|
| `RUN_MODE` | Bot execution mode: `watch` or `once` | `watch` | `once` |
| `EXIT_AFTER_SYNC` | Exit after sync completion | `false` | `true` |
| `REGISTER_COMMANDS` | Register commands in one-time mode | `false` | `true` |

#### Run Modes

- **Watch Mode** (`RUN_MODE=watch`): Normal bot operation with continuous monitoring
  - Registers Discord event handlers
  - Processes real-time messages and threads
  - Registers slash commands
  - Runs indefinitely until manually stopped

- **One-Time Mode** (`RUN_MODE=once`): Execute once and exit
  - Skips event handler registration
  - Primarily used for historical sync operations
  - Automatically exits after completion
  - Useful for scheduled sync jobs or migrations
| `SYNC_THREAD_ID` | Thread to sync (optional) | `111222333444555666` |
| `SYNC_LIMIT` | Max threads to process | `100` |
| `SYNC_SKIP_EXISTING` | Skip existing content | `true` |

### Discord Setup

1. Create a Discord Application at https://discord.com/developers/applications
2. Create a bot user and copy the token
3. Enable the following bot permissions:
   - View Channels
   - Read Message History
   - Read Messages/View Channels
4. Enable the following privileged gateway intents:
   - Message Content Intent
5. Invite the bot to your server with appropriate permissions

### Database Schema

The bot automatically creates the following tables:

- **channels**: Discord channel information
- **threads**: Forum thread data
- **posts**: Thread replies
- **staff_roles**: Staff member roles and tags
- **audit_log**: Complete audit trail
- **moderation_queue**: Content moderation queue

## Usage

### Staff Management

#### CSV Import

Create a `staff.csv` file with the following format:
```csv
discordUserId,publicTag
123456789012345678,Admin
987654321098765432,Moderator
```

The bot will automatically import staff roles on startup if `STAFF_CSV_PATH` is set.

### Historical Data Sync

The bot features an intelligent **Smart Sync** system that automatically decides between full and delta synchronization. No more manual configuration or scheduling - one function handles everything.

#### Smart Sync Features

**Automatic Decision Making:**
- **First Run**: Automatically performs full historical sync
- **Subsequent Runs**: Only syncs new/updated content since last run
- **Override Option**: Force full sync when needed

**Single Source of Truth:**
The sync state is stored in the database `config` table with:
- `last_sync`: Timestamp of last successful sync
- `is_first_run`: Flag indicating if this is the first run

#### Run Mode Configuration for Smart Sync

**Watch Mode (Default)**
```env
RUN_MODE=watch
ENABLE_HISTORICAL_SYNC=true
```
- Runs smart sync and then continues normal bot operations
- Suitable for production deployments

**One-Time Mode**
```env
RUN_MODE=once
ENABLE_HISTORICAL_SYNC=true
EXIT_AFTER_SYNC=true
```
- Runs smart sync only and then exits
- Perfect for scheduled jobs, migrations, or CI/CD pipelines
- Does not register event handlers or stay running

#### Environment-Based Sync

Configure these variables in your `.env` file to enable smart sync:

```env
# Enable smart sync on startup
ENABLE_HISTORICAL_SYNC=true

# Optional: Force full sync instead of smart decision
FORCE_FULL_SYNC=false
```

#### Smart Sync Algorithm

1. **Read sync state** from `config` table
2. **Decision logic:**
   - If `FORCE_FULL_SYNC=true` → Full sync
   - If `is_first_run=1` → Full sync  
   - Otherwise → Delta sync (messages after `last_sync`)
3. **Process all guilds** and forum channels automatically
4. **Update sync state** after completion

### Content Sanitization

All content is automatically sanitized to remove:

- Discord mentions (@user, #channel, @role)
- Custom Discord emojis
- Script tags and JavaScript
- Personal Identifiable Information (PII):
  - Email addresses
  - Phone numbers
  - Social Security Numbers
  - Credit card numbers

### User Privacy

- Discord user IDs are hashed using SHA-256 + pepper
- Only 12-character aliases are stored
- Original user IDs are never persisted