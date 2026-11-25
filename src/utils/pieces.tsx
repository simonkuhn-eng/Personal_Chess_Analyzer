import React from 'react';

// Standard high-definition Neo / Chess.com style vector piece components
export const ChessPieces: Record<string, React.FC<{ className?: string }>> = {
  // White Pieces
  wP: ({ className = '' }) => (
    <svg viewBox="0 0 45 45" className={className}>
      <path
        d="m 22.5,9 c -2.21,0 -4,1.79 -4,4 0,0.89 0.29,1.71 0.78,2.38 C 17.33,16.5 16,18.59 16,21 c 0,2.03 0.94,3.84 2.41,5.03 C 15.41,27.09 11,31.58 11,39.5 l 23,0 c 0,-7.92 -4.41,-12.41 -7.41,-13.47 C 28.06,24.84 29,23.03 29,21 29,18.59 27.67,16.5 25.72,15.38 26.21,14.71 26.5,13.89 26.5,13 c 0,-2.21 -1.79,-4 -4,-4 z"
        fill="#ffffff"
        stroke="#1a1a1a"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  ),
  wN: ({ className = '' }) => (
    <svg viewBox="0 0 45 45" className={className}>
      <path
        d="m 22,10 c 10.5,1 16.5,8 16,29 L 15,39 C 15,30 11.5,25 9.5,22.5 7.5,20 8.5,18 10,17.5 c 2,-0.5 3,1 3,1 0,-3 3.5,-7.5 10,-8.5 z"
        fill="#ffffff"
        stroke="#1a1a1a"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="m 24,18 c 0.38,2.91 -5.55,7.37 -8,9 -3,2 -2.82,4.34 -5,4 -1.04,-0.94 -1.41,-3.04 0,-4 1.5,-1 5,-2.5 6.5,-4 1.5,-1.5 2.5,-3.5 2.5,-5 0,-1.5 4,-2 4,0 z"
        fill="#ffffff"
        stroke="#1a1a1a"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="9.5" cy="25.5" r="1.25" fill="#1a1a1a" />
      <path
        d="M 15 15.5 A 0.5 1.5 0 1 1 14,15.5 A 0.5 1.5 0 1 1 15 15.5 z"
        transform="matrix(0.866,0.5,-0.5,0.866,9.693,-5.173)"
        fill="#1a1a1a"
      />
    </svg>
  ),
  wB: ({ className = '' }) => (
    <svg viewBox="0 0 45 45" className={className}>
      <g fill="none" fillRule="evenodd" stroke="#1a1a1a" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path
          d="m 9,36 c 3.39,-0.97 10.11,0.43 13.5,-2 3.39,2.43 10.11,1.03 13.5,2 0,0 1.65,0.54 3,2 -0.68,0.97 -1.65,0.99 -3,1 -3.39,-0.21 -10.11,1.19 -13.5,-1 -3.39,2.19 -10.11,0.79 -13.5,1 -1.35,-0.01 -2.32,-0.03 -3,-1 1.35,-1.46 3,-2 3,-2 z"
          fill="#ffffff"
        />
        <path
          d="m 15,32 c 2.5,2.5 12.5,2.5 15,0 0.5,-1.5 0,-2 0,-2 0,-2.5 -2.5,-4 -2.5,-4 5.5,-1.5 6,-11.5 -5,-15.5 -11,4 -10.5,14 -5,15.5 0,0 -2.5,1.5 -2.5,4 0,0 -0.5,0.5 0,2 z"
          fill="#ffffff"
        />
        <path d="m 25,8 a 2.5,2.5 0 1 1 -5,0 2.5,2.5 0 1 1 5,0 z" fill="#ffffff" />
        <path d="m 17.5,26 10,0 M 15,30 30,30 M 22.5,15.5 22.5,20.5 M 20,18 25,18" />
      </g>
    </svg>
  ),
  wR: ({ className = '' }) => (
    <svg viewBox="0 0 45 45" className={className}>
      <g fill="#ffffff" fillRule="evenodd" stroke="#1a1a1a" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path
          d="m 9,39 27,0 c 0,-3 -2.5,-4.5 -4.5,-5 l -18,0 C 11.5,34.5 9,36 9,39 z"
          strokeLinecap="butt"
        />
        <path d="m 12,34 21,0 c 0,-5 -3.5,-6 -3.5,-11 l -14,0 c 0,5 -3.5,6 -3.5,11 z" />
        <path
          d="m 12,12 0,11 21,0 0,-11 -4,0 0,4 -3,0 0,-4 -4,0 0,4 -3,0 0,-4 -7,0 z"
          strokeLinecap="butt"
        />
        <path d="m 14,29.5 17,0 M 14,16.5 31,16.5" fill="none" strokeWidth="1" />
      </g>
    </svg>
  ),
  wQ: ({ className = '' }) => (
    <svg viewBox="0 0 45 45" className={className}>
      <g fill="#ffffff" fillRule="evenodd" stroke="#1a1a1a" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="m 9,26 c 8.5,-1.5 21,-1.5 27,0 l 2,-12 -7,11 -4,-15 -4.5,15 -4.5,-15 -4,15 -7,-11 2,12 z" />
        <path
          d="m 9,26 c 0,2 1.5,2 2.5,4 1,1.5 1,1 0.5,3.5 -1.5,1 -1.5,2.5 -1.5,2.5 -1.5,1.5 0.5,2.5 0.5,2.5 6.5,1 16.5,1 23,0 0,0 1.5,-1 0.5,-2.5 0,0 0,-1.5 -1.5,-2.5 -0.5,-2.5 -0.5,-2 0.5,-3.5 1,-2 2.5,-2 2.5,-4-8.5,-1.5 -18.5,-1.5 -27,0 z"
        />
        <circle cx="6" cy="12" r="2" />
        <circle cx="14" cy="9" r="2" />
        <circle cx="22.5" cy="8" r="2" />
        <circle cx="31" cy="9" r="2" />
        <circle cx="39" cy="12" r="2" />
        <path d="m 11,38.5 23,0 M 12,34.5 33,34.5" fill="none" />
      </g>
    </svg>
  ),
  wK: ({ className = '' }) => (
    <svg viewBox="0 0 45 45" className={className}>
      <g fill="none" fillRule="evenodd" stroke="#1a1a1a" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="m 22.5,11.63 0,-6 M 20,8.5 25,8.5" />
        <path
          d="m 22.5,25 c 0,0 4.5,-7.5 3,-10.5 -1.5,-3 -6,-3 -7.5,0 -1.5,3 3,10.5 3,10.5"
          fill="#ffffff"
        />
        <path
          d="m 11.5,37 c 5.5,3.5 16.5,3.5 22,0 l 0,-7 c 0,0 0.5,-3 -2.5,-4 -3,-1 -4,1.5 -8.5,1.5 -4.5,0 -5.5,-2.5 -8.5,-1.5 -3,1 -2.5,4 -2.5,4 l 0,7 z"
          fill="#ffffff"
        />
        <path d="m 11.5,30 c 5.5,-2 16.5,-2 22,0 M 11.5,33.5 c 5.5,-2 16.5,-2 22,0 M 11.5,37 c 5.5,-2 16.5,-2 22,0" />
      </g>
    </svg>
  ),

  // Black Pieces
  bP: ({ className = '' }) => (
    <svg viewBox="0 0 45 45" className={className}>
      <path
        d="m 22.5,9 c -2.21,0 -4,1.79 -4,4 0,0.89 0.29,1.71 0.78,2.38 C 17.33,16.5 16,18.59 16,21 c 0,2.03 0.94,3.84 2.41,5.03 C 15.41,27.09 11,31.58 11,39.5 l 23,0 c 0,-7.92 -4.41,-12.41 -7.41,-13.47 C 28.06,24.84 29,23.03 29,21 29,18.59 27.67,16.5 25.72,15.38 26.21,14.71 26.5,13.89 26.5,13 c 0,-2.21 -1.79,-4 -4,-4 z"
        fill="#262421"
        stroke="#ffffff"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  ),
  bN: ({ className = '' }) => (
    <svg viewBox="0 0 45 45" className={className}>
      <path
        d="m 22,10 c 10.5,1 16.5,8 16,29 L 15,39 C 15,30 11.5,25 9.5,22.5 7.5,20 8.5,18 10,17.5 c 2,-0.5 3,1 3,1 0,-3 3.5,-7.5 10,-8.5 z"
        fill="#262421"
        stroke="#ffffff"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="m 24,18 c 0.38,2.91 -5.55,7.37 -8,9 -3,2 -2.82,4.34 -5,4 -1.04,-0.94 -1.41,-3.04 0,-4 1.5,-1 5,-2.5 6.5,-4 1.5,-1.5 2.5,-3.5 2.5,-5 0,-1.5 4,-2 4,0 z"
        fill="#262421"
        stroke="#ffffff"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <circle cx="9.5" cy="25.5" r="1.25" fill="#ffffff" />
      <path
        d="M 15 15.5 A 0.5 1.5 0 1 1 14,15.5 A 0.5 1.5 0 1 1 15 15.5 z"
        transform="matrix(0.866,0.5,-0.5,0.866,9.693,-5.173)"
        fill="#ffffff"
      />
    </svg>
  ),
  bB: ({ className = '' }) => (
    <svg viewBox="0 0 45 45" className={className}>
      <g fill="none" fillRule="evenodd" stroke="#ffffff" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
        <path
          d="m 9,36 c 3.39,-0.97 10.11,0.43 13.5,-2 3.39,2.43 10.11,1.03 13.5,2 0,0 1.65,0.54 3,2 -0.68,0.97 -1.65,0.99 -3,1 -3.39,-0.21 -10.11,1.19 -13.5,-1 -3.39,2.19 -10.11,0.79 -13.5,1 -1.35,-0.01 -2.32,-0.03 -3,-1 1.35,-1.46 3,-2 3,-2 z"
          fill="#262421"
        />
        <path
          d="m 15,32 c 2.5,2.5 12.5,2.5 15,0 0.5,-1.5 0,-2 0,-2 0,-2.5 -2.5,-4 -2.5,-4 5.5,-1.5 6,-11.5 -5,-15.5 -11,4 -10.5,14 -5,15.5 0,0 -2.5,1.5 -2.5,4 0,0 -0.5,0.5 0,2 z"
          fill="#262421"
        />
        <path d="m 25,8 a 2.5,2.5 0 1 1 -5,0 2.5,2.5 0 1 1 5,0 z" fill="#262421" />
        <path d="m 17.5,26 10,0 M 15,30 30,30 M 22.5,15.5 22.5,20.5 M 20,18 25,18" stroke="#ffffff" />
      </g>
    </svg>
  ),
  bR: ({ className = '' }) => (
    <svg viewBox="0 0 45 45" className={className}>
      <g fill="#262421" fillRule="evenodd" stroke="#ffffff" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
        <path
          d="m 9,39 27,0 c 0,-3 -2.5,-4.5 -4.5,-5 l -18,0 C 11.5,34.5 9,36 9,39 z"
          strokeLinecap="butt"
        />
        <path d="m 12,34 21,0 c 0,-5 -3.5,-6 -3.5,-11 l -14,0 c 0,5 -3.5,6 -3.5,11 z" />
        <path
          d="m 12,12 0,11 21,0 0,-11 -4,0 0,4 -3,0 0,-4 -4,0 0,4 -3,0 0,-4 -7,0 z"
          strokeLinecap="butt"
        />
        <path d="m 14,29.5 17,0 M 14,16.5 31,16.5" fill="none" stroke="#ffffff" strokeWidth="1" />
      </g>
    </svg>
  ),
  bQ: ({ className = '' }) => (
    <svg viewBox="0 0 45 45" className={className}>
      <g fill="#262421" fillRule="evenodd" stroke="#ffffff" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="m 9,26 c 8.5,-1.5 21,-1.5 27,0 l 2,-12 -7,11 -4,-15 -4.5,15 -4.5,-15 -4,15 -7,-11 2,12 z" />
        <path
          d="m 9,26 c 0,2 1.5,2 2.5,4 1,1.5 1,1 0.5,3.5 -1.5,1 -1.5,2.5 -1.5,2.5 -1.5,1.5 0.5,2.5 0.5,2.5 6.5,1 16.5,1 23,0 0,0 1.5,-1 0.5,-2.5 0,0 0,-1.5 -1.5,-2.5 -0.5,-2.5 -0.5,-2 0.5,-3.5 1,-2 2.5,-2 2.5,-4-8.5,-1.5 -18.5,-1.5 -27,0 z"
        />
        <circle cx="6" cy="12" r="2" />
        <circle cx="14" cy="9" r="2" />
        <circle cx="22.5" cy="8" r="2" />
        <circle cx="31" cy="9" r="2" />
        <circle cx="39" cy="12" r="2" />
        <path d="m 11,38.5 23,0 M 12,34.5 33,34.5" fill="none" stroke="#ffffff" />
      </g>
    </svg>
  ),
  bK: ({ className = '' }) => (
    <svg viewBox="0 0 45 45" className={className}>
      <g fill="none" fillRule="evenodd" stroke="#ffffff" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="m 22.5,11.63 0,-6 M 20,8.5 25,8.5" stroke="#ffffff" />
        <path
          d="m 22.5,25 c 0,0 4.5,-7.5 3,-10.5 -1.5,-3 -6,-3 -7.5,0 -1.5,3 3,10.5 3,10.5"
          fill="#262421"
        />
        <path
          d="m 11.5,37 c 5.5,3.5 16.5,3.5 22,0 l 0,-7 c 0,0 0.5,-3 -2.5,-4 -3,-1 -4,1.5 -8.5,1.5 -4.5,0 -5.5,-2.5 -8.5,-1.5 -3,1 -2.5,4 -2.5,4 l 0,7 z"
          fill="#262421"
        />
        <path d="m 11.5,30 c 5.5,-2 16.5,-2 22,0 M 11.5,33.5 c 5.5,-2 16.5,-2 22,0 M 11.5,37 c 5.5,-2 16.5,-2 22,0" stroke="#ffffff" />
      </g>
    </svg>
  ),
};
