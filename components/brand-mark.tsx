import Image from 'next/image';

export function BrandMark({ size = 30 }: { size?: number }) {
  return (
    <Image
      src="/engram-brain-network.png?v=20261015"
      alt=""
      width={size}
      height={size}
      aria-hidden="true"
      unoptimized
      priority
      style={{ objectFit: 'contain' }}
    />
  );
}
