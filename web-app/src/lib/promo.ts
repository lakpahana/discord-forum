// Build-time promotional banner logic

export interface BannerConfig {
    everyNPages: number;
    discordInviteUrl: string;
    message: string;
}

export function shouldShowBanner(pageIndex: number, config: BannerConfig): boolean {
    if (config.everyNPages <= 0) return false;
    return (pageIndex + 1) % config.everyNPages === 0;
}

export function getBannerConfig(): BannerConfig {
    const everyN = parseInt(process.env.BANNER_EVERY_N || '4');
    const inviteUrl = process.env.DISCORD_INVITE_URL || 'https://discord.gg/your-invite-code';

    return {
        everyNPages: everyN,
        discordInviteUrl: inviteUrl,
        message: 'Join our Discord – click here!'
    };
}

// Generate the inline dismiss script (vanilla JS, < 1KB)
export function generateBannerScript(): string {
    return `
(function() {
  'use strict';
  
  // Check if banner was dismissed
  if (localStorage.getItem('bannerDismissed') === 'true') {
    var banner = document.getElementById('promo-banner');
    if (banner) banner.style.display = 'none';
    return;
  }
  
  // Add dismiss functionality
  var dismissBtn = document.getElementById('banner-dismiss');
  if (dismissBtn) {
    dismissBtn.addEventListener('click', function(e) {
      e.preventDefault();
      localStorage.setItem('bannerDismissed', 'true');
      var banner = document.getElementById('promo-banner');
      if (banner) {
        banner.style.transition = 'opacity 0.3s ease';
        banner.style.opacity = '0';
        setTimeout(function() {
          banner.style.display = 'none';
        }, 300);
      }
    });
  }
})();
`.trim();
}
