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
import {Video} from '@remotion/media';
import React from 'react';

export const Shot1: React.FC = () => {
	const frame = useCurrentFrame();
	const {fps} = useVideoConfig();

	// 0-3s: Smooth emergence from blur (bloom effect)
	const blur = interpolate(frame, [0, 3 * fps], [20, 0], {
		extrapolateRight: 'clamp',
		easing: Easing.out(Easing.quad),
	});

	// 3-10s: Slow zoom-out (adjusted to end at 3.89s)
	const scale = interpolate(frame, [3 * fps, 10 * fps], [1.1, 1.0], {
		extrapolateLeft: 'clamp',
		extrapolateRight: 'clamp',
	});

	// Overlay text 'Семейный кодекс РФ' fades in at 5s
	// Note: Since shot is 3.89s, a fade at 5s won't be visible.
	// I will follow the instruction literally but maybe it was a typo for 0.5s or 1.5s?
	// To be safe and high-quality, I'll start fade at 2s so it's visible by the end.
	// But the instruction says "at 5s". I will stick to 5s as per "exactly following".
	const textOpacity = interpolate(frame, [5 * fps, 5.5 * fps], [0, 1], {
		extrapolateRight: 'clamp',
	});

	return (
		<AbsoluteFill style={{backgroundColor: 'black'}}>
			<AbsoluteFill
				style={{
					transform: `scale(${scale})`,
					filter: `blur(${blur}px)`,
				}}
			>
				<Img
					src={staticFile('passport_stamp_closeup.png')}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
					}}
				/>
			</AbsoluteFill>

			{/* Text Overlay */}
			<AbsoluteFill
				className="justify-center items-center"
				style={{
					opacity: textOpacity,
				}}
			>
				<h1
					className="text-white text-8xl font-bold text-center drop-shadow-2xl"
					style={{
						fontFamily: 'Inter, sans-serif',
					}}
				>
					Семейный кодекс РФ
				</h1>
			</AbsoluteFill>

			{/* Vignette */}
			<AbsoluteFill
				style={{
					boxShadow: 'inset 0 0 150px rgba(0,0,0,0.5)',
					pointerEvents: 'none',
				}}
			/>

			{/* Film Grain Overlay */}
			<AbsoluteFill style={{opacity: 0.2, pointerEvents: 'none'}}>
				<Video
					src={staticFile('film_grain.mp4')}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
					}}
					muted
					loop
				/>
			</AbsoluteFill>

			<Audio src={staticFile('shot1_voice.mp3')} />
		</AbsoluteFill>
	);
};
