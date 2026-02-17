import {
	AbsoluteFill,
	interpolate,
	useCurrentFrame,
	useVideoConfig,
	Img,
	staticFile,
	Audio,
	Easing,
} from 'remotion';
import React from 'react';

export const Shot14: React.FC = () => {
	const frame = useCurrentFrame();
	const {durationInFrames} = useVideoConfig();

	// Timeline scaling: 8.38s total (251 frames)
	// Original segments: 0-5s, 5-10s, 10-16s -> Total 16s
	// Ratios: 5/16, 5/16, 6/16
	
	const seg1End = Math.round((5 / 16) * durationInFrames);
	const seg2End = Math.round((10 / 16) * durationInFrames);

	// Wipe Transitions (reveals from left)
	const wipe2 = interpolate(
		frame,
		[seg1End - 15, seg1End + 15],
		[0, 100],
		{extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.inOut(Easing.quad)}
	);

	const wipe3 = interpolate(
		frame,
		[seg2End - 15, seg2End + 15],
		[0, 100],
		{extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.inOut(Easing.quad)}
	);

	return (
		<AbsoluteFill style={{backgroundColor: 'black'}}>
			{/* 1. Prison Bars (Dark) */}
			<AbsoluteFill>
				<Img
					src={staticFile('prison_bars.png')}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
						filter: 'brightness(0.5) contrast(1.2)', // Dark grade
					}}
				/>
				<AbsoluteFill style={{backgroundColor: 'rgba(0,0,0,0.5)', mixBlendMode: 'multiply'}} />
			</AbsoluteFill>

			{/* 2. Psychiatric Ward (Sterile) - Wipe In */}
			<AbsoluteFill
				style={{
					clipPath: `polygon(0 0, ${wipe2}% 0, ${wipe2}% 100%, 0 100%)`,
				}}
			>
				<Img
					src={staticFile('psychiatric_ward.png')}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
						filter: 'brightness(1.1) saturate(0.2) contrast(1.1)', // Sterile/Cold grade
					}}
				/>
				<AbsoluteFill style={{backgroundColor: 'rgba(200, 240, 255, 0.2)', mixBlendMode: 'overlay'}} />
			</AbsoluteFill>

			{/* 3. Empty Chair (Stormy) - Wipe In */}
			<AbsoluteFill
				style={{
					clipPath: `polygon(0 0, ${wipe3}% 0, ${wipe3}% 100%, 0 100%)`,
				}}
			>
				<Img
					src={staticFile('empty_chair_missing.png')}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
						filter: 'contrast(1.3) sepia(0.3) hue-rotate(180deg)', // Stormy/Unsettling
					}}
				/>
				<AbsoluteFill style={{backgroundColor: 'rgba(50, 60, 80, 0.5)', mixBlendMode: 'hard-light'}} />
			</AbsoluteFill>

			<Audio src={staticFile('shot14_voice.mp3')} />
		</AbsoluteFill>
	);
};
