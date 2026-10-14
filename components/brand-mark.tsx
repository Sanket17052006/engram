export function BrandMark({size=18}:{size?:number}){
  return <svg width={size} height={size} viewBox="0 0 36 36" fill="none" aria-hidden="true">
    <path d="M9 10.5C14.4 10.5 13.8 17.6 18 18M27 10.5C21.6 10.5 22.2 17.6 18 18M9 25.5C14.4 25.5 13.8 18.4 18 18M27 25.5C21.6 25.5 22.2 18.4 18 18" stroke="#F5EBDD" strokeWidth="1.8" strokeLinecap="round"/>
    <path d="M18 7.5V11M18 25V28.5" stroke="#E7A35D" strokeWidth="1.8" strokeLinecap="round"/>
    <circle cx="9" cy="10.5" r="3" fill="#E99A4C"/><circle cx="27" cy="10.5" r="3" fill="#9EB18F"/>
    <circle cx="9" cy="25.5" r="3" fill="#9EB18F"/><circle cx="27" cy="25.5" r="3" fill="#E99A4C"/>
    <circle cx="18" cy="18" r="5" fill="#ED821A"/><circle cx="18" cy="18" r="1.6" fill="#FFF7EC"/>
    <circle cx="18" cy="6.5" r="1.5" fill="#FFF7EC"/><circle cx="18" cy="29.5" r="1.5" fill="#FFF7EC"/>
  </svg>
}
