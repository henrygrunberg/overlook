import type { PhotoId } from "../settings/settings";

export interface Photo {
  readonly name: string;
  readonly photographer: string;
}

export const DEFAULT_PHOTO: PhotoId = "autumn-forest";

export const PHOTOS: Readonly<Record<PhotoId, Photo>> = {
  "autumn-forest": { name: "Autumn forest", photographer: "Kush Dwivedi" },
  "still-lake": { name: "Still lake", photographer: "Ahmet Yüksek" },
  "golden-haze": { name: "Golden haze", photographer: "Cristina Gottardi" },
  "alpine-ridge": { name: "Alpine ridge", photographer: "Dario Jud" },
};

export const photoSrc = (id: PhotoId) => `backgrounds/${id}.avif`;
export const photoThumbnailSrc = (id: PhotoId) => `backgrounds/thumbs/${id}.avif`;
