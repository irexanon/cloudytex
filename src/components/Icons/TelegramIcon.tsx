import React from 'react';

export default function TelegramIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="m20.303 2.38-18 7a.5.5 0 0 0 .076.953l4.382.972 1.818 5.454a.5.5 0 0 0 .844.157l2.425-2.888 4.854 3.56a.5.5 0 0 0 .784-.288L21 2.9a.5.5 0 0 0-.697-.52zm-1.19 1.71-9.452 9.2-2.113-6.337L19.113 4.09z"/>
    </svg>
  );
}
