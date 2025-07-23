-- Database initialization script
CREATE DATABASE IF NOT EXISTS forum;
USE forum;

-- Configuration table for storing app state
CREATE TABLE IF NOT EXISTS config (
    key_name VARCHAR(32) PRIMARY KEY,
    value VARCHAR(255),
    updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
);

-- Initialize sync state configuration
INSERT IGNORE INTO config (key_name, value, updated_at) VALUES
('sync_state', JSON_OBJECT('last_sync', '1970-01-01T00:00:00.000Z', 'is_first_run', 1), NOW());

-- Channels table
CREATE TABLE IF NOT EXISTS channels (
    id BIGINT PRIMARY KEY,
    slug VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    position INT DEFAULT 0,
    created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
    INDEX idx_slug (slug),
    INDEX idx_position (position)
);

-- Threads table
CREATE TABLE IF NOT EXISTS threads (
    id BIGINT PRIMARY KEY,
    channel_id BIGINT NOT NULL,
    slug VARCHAR(255) UNIQUE NOT NULL,
    title VARCHAR(255) NOT NULL,
    author_alias CHAR(12) NOT NULL,
    body_html MEDIUMTEXT,
    tags JSON,
    reply_count INT DEFAULT 0,
    created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
    INDEX idx_channel_id (channel_id),
    INDEX idx_slug (slug),
    INDEX idx_created_at (created_at),
    INDEX idx_updated_at (updated_at)
);

-- Posts table
CREATE TABLE IF NOT EXISTS posts (
    id BIGINT PRIMARY KEY,
    thread_id BIGINT NOT NULL,
    author_alias CHAR(12) NOT NULL,
    body_html MEDIUMTEXT,
    reply_to_id BIGINT NULL,
    reply_to_author_alias CHAR(12) NULL,
    created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
    FOREIGN KEY (reply_to_id) REFERENCES posts(id) ON DELETE SET NULL,
    INDEX idx_thread_id (thread_id),
    INDEX idx_reply_to_id (reply_to_id),
    INDEX idx_created_at (created_at)
);

-- Staff roles table
CREATE TABLE IF NOT EXISTS staff_roles (
    discord_user_id_hash CHAR(12) PRIMARY KEY,
    public_tag VARCHAR(50) NOT NULL,
    added_by VARCHAR(50) NOT NULL,
    added_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
    INDEX idx_public_tag (public_tag)
);

-- Audit log table
CREATE TABLE IF NOT EXISTS audit_log (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    actor VARCHAR(50) NOT NULL,
    action ENUM('INSERT', 'UPDATE', 'DELETE') NOT NULL,
    table_name VARCHAR(64) NOT NULL,
    old_val JSON,
    new_val JSON,
    ts DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
    INDEX idx_actor (actor),
    INDEX idx_action (action),
    INDEX idx_table_name (table_name),
    INDEX idx_ts (ts)
);

-- Moderation queue table (for future moderation features)
CREATE TABLE IF NOT EXISTS moderation_queue (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    content_type ENUM('thread', 'post') NOT NULL,
    content_id BIGINT NOT NULL,
    status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
    reason TEXT,
    flagged_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
    reviewed_at DATETIME(3) NULL,
    reviewed_by VARCHAR(50) NULL,
    INDEX idx_status (status),
    INDEX idx_content_type (content_type),
    INDEX idx_flagged_at (flagged_at)
);

-- Create audit triggers
DELIMITER $$

-- Threads audit triggers
CREATE TRIGGER threads_after_insert AFTER INSERT ON threads
FOR EACH ROW BEGIN
    INSERT INTO audit_log (actor, action, table_name, new_val)
    VALUES ('system', 'INSERT', 'threads', JSON_OBJECT(
        'id', NEW.id,
        'channel_id', NEW.channel_id,
        'slug', NEW.slug,
        'title', NEW.title,
        'author_alias', NEW.author_alias,
        'reply_count', NEW.reply_count,
        'created_at', NEW.created_at
    ));
END$$

CREATE TRIGGER threads_after_update AFTER UPDATE ON threads
FOR EACH ROW BEGIN
    INSERT INTO audit_log (actor, action, table_name, old_val, new_val)
    VALUES ('system', 'UPDATE', 'threads', 
        JSON_OBJECT(
            'id', OLD.id,
            'title', OLD.title,
            'reply_count', OLD.reply_count,
            'updated_at', OLD.updated_at
        ),
        JSON_OBJECT(
            'id', NEW.id,
            'title', NEW.title,
            'reply_count', NEW.reply_count,
            'updated_at', NEW.updated_at
        )
    );
END$$

CREATE TRIGGER threads_after_delete AFTER DELETE ON threads
FOR EACH ROW BEGIN
    INSERT INTO audit_log (actor, action, table_name, old_val)
    VALUES ('system', 'DELETE', 'threads', JSON_OBJECT(
        'id', OLD.id,
        'channel_id', OLD.channel_id,
        'slug', OLD.slug,
        'title', OLD.title,
        'author_alias', OLD.author_alias
    ));
END$$

-- Posts audit triggers
CREATE TRIGGER posts_after_insert AFTER INSERT ON posts
FOR EACH ROW BEGIN
    INSERT INTO audit_log (actor, action, table_name, new_val)
    VALUES ('system', 'INSERT', 'posts', JSON_OBJECT(
        'id', NEW.id,
        'thread_id', NEW.thread_id,
        'author_alias', NEW.author_alias,
        'reply_to_id', NEW.reply_to_id,
        'reply_to_author_alias', NEW.reply_to_author_alias,
        'created_at', NEW.created_at
    ));
END$$

CREATE TRIGGER posts_after_update AFTER UPDATE ON posts
FOR EACH ROW BEGIN
    INSERT INTO audit_log (actor, action, table_name, old_val, new_val)
    VALUES ('system', 'UPDATE', 'posts', 
        JSON_OBJECT(
            'id', OLD.id, 
            'body_html', OLD.body_html, 
            'reply_to_id', OLD.reply_to_id,
            'reply_to_author_alias', OLD.reply_to_author_alias,
            'updated_at', OLD.updated_at
        ),
        JSON_OBJECT(
            'id', NEW.id, 
            'body_html', NEW.body_html, 
            'reply_to_id', NEW.reply_to_id,
            'reply_to_author_alias', NEW.reply_to_author_alias,
            'updated_at', NEW.updated_at
        )
    );
END$$

CREATE TRIGGER posts_after_delete AFTER DELETE ON posts
FOR EACH ROW BEGIN
    INSERT INTO audit_log (actor, action, table_name, old_val)
    VALUES ('system', 'DELETE', 'posts', JSON_OBJECT(
        'id', OLD.id,
        'thread_id', OLD.thread_id,
        'author_alias', OLD.author_alias
    ));
END$$

DELIMITER ;

-- Insert default channels if they don't exist
INSERT IGNORE INTO channels (id, slug, name, description, position) VALUES
(1, 'general', 'General Discussion', 'General forum discussion', 1),
(2, 'announcements', 'Announcements', 'Important announcements', 0),
(3, 'support', 'Support', 'Technical support and help', 2);
