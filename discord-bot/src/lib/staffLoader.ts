import fs from 'fs';
import path from 'path';
import csv from 'csv-parser';
import { query } from './db';
import { hashUserId } from './hash';
import { createLogger } from './logger';

const logger = createLogger('staffLoader');

interface StaffRecord {
    discordId: string;
    tag: string;
}

export async function loadStaffFromCSV(csvPath: string): Promise<void> {
    if (!fs.existsSync(csvPath)) {
        logger.info({ csvPath }, 'Staff CSV file not found, skipping staff load');
        return;
    }

    const records: StaffRecord[] = [];

    return new Promise((resolve, reject) => {
        fs.createReadStream(csvPath)
            .pipe(csv({
                headers: ['discordId', 'tag'],
            }))
            .on('data', (row: Record<string, string>) => {
                if (row.discordId && row.tag && row.discordId.trim() && row.tag.trim()) {
                    records.push({
                        discordId: row.discordId.trim(),
                        tag: row.tag.trim(),
                    });
                }
            })
            .on('end', async () => {
                try {
                    let imported = 0;
                    let updated = 0;

                    for (const record of records) {
                        try {
                            const hashedId = hashUserId(record.discordId);

                            const result = await query(`
                INSERT INTO staff_roles (discord_user_id_hash, public_tag, added_by, added_at)
                VALUES (?, ?, 'csv-import', NOW())
                ON DUPLICATE KEY UPDATE
                  public_tag = VALUES(public_tag),
                  added_by = 'csv-import',
                  added_at = NOW()
              `, [hashedId, record.tag]);

                            if ((result as any).affectedRows > 0) {
                                if ((result as any).insertId > 0) {
                                    imported++;
                                } else {
                                    updated++;
                                }
                            }

                        } catch (error) {
                            logger.error({ error, record }, 'Failed to process staff record');
                        }
                    }

                    logger.info({
                        totalRecords: records.length,
                        imported,
                        updated,
                        csvPath,
                    }, 'Staff CSV processing complete');

                    resolve();
                } catch (error) {
                    reject(error);
                }
            })
            .on('error', (error: Error) => {
                logger.error({ error, csvPath }, 'Error reading staff CSV');
                reject(error);
            });
    });
}

export async function getStaffTag(discordUserId: string): Promise<string | null> {
    try {
        const hashedId = hashUserId(discordUserId);

        const result = await query<{ public_tag: string }>(`
      SELECT public_tag
      FROM staff_roles
      WHERE discord_user_id_hash = ?
    `, [hashedId]);

        return result[0]?.public_tag || null;
    } catch (error) {
        logger.error({ error, discordUserId }, 'Failed to get staff tag');
        return null;
    }
}

export async function isStaff(discordUserId: string): Promise<boolean> {
    try {
        const hashedId = hashUserId(discordUserId);

        const result = await query<{ count: number }>(`
      SELECT COUNT(*) as count
      FROM staff_roles
      WHERE discord_user_id_hash = ?
    `, [hashedId]);

        return (result[0]?.count || 0) > 0;
    } catch (error) {
        logger.error({ error, discordUserId }, 'Failed to check staff status');
        return false;
    }
}

export async function addStaffRole(discordUserId: string, tag: string, addedBy: string): Promise<boolean> {
    try {
        const hashedId = hashUserId(discordUserId);

        await query(`
      INSERT INTO staff_roles (discord_user_id_hash, public_tag, added_by, added_at)
      VALUES (?, ?, ?, NOW())
      ON DUPLICATE KEY UPDATE
        public_tag = VALUES(public_tag),
        added_by = VALUES(added_by),
        added_at = NOW()
    `, [hashedId, tag, addedBy]);

        logger.info({ discordUserId, tag, addedBy }, 'Staff role added/updated');
        return true;
    } catch (error) {
        logger.error({ error, discordUserId, tag, addedBy }, 'Failed to add staff role');
        return false;
    }
}

export async function removeStaffRole(discordUserId: string): Promise<boolean> {
    try {
        const hashedId = hashUserId(discordUserId);

        const result = await query(`
      DELETE FROM staff_roles
      WHERE discord_user_id_hash = ?
    `, [hashedId]);

        const deleted = (result as any).affectedRows > 0;

        if (deleted) {
            logger.info({ discordUserId }, 'Staff role removed');
        } else {
            logger.warn({ discordUserId }, 'No staff role found to remove');
        }

        return deleted;
    } catch (error) {
        logger.error({ error, discordUserId }, 'Failed to remove staff role');
        return false;
    }
}
