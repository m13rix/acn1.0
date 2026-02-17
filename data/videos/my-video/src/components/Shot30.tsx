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

export const Shot30: React.FC = () => {
	const frame = useCurrentFrame();
	const {durationInFrames} = useVideoConfig();

	// Timeline scaling: 7.18s total
	// Segments: 0-8s (Wall), 8-12s (Dissolve), 12-15s (Free) -> 15s total original
	const dissolveStart = Math.round((8 / 15) * durationInFrames);
	const dissolveEnd = Math.round((12 / 15) * durationInFrames);

	// Wall Dissolve Animation
	const wallOpacity = interpolate(
		frame,
		[dissolveStart, dissolveEnd],
		[1, 0],
		{extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}
	);
	
	const wallBlur = interpolate(
		frame,
		[dissolveStart, dissolveEnd],
		[0, 20],
		{extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}
	);

	// Person Movement (Walking through)
	// We simulate this with a zoom-in/pan after dissolve
	const walkProgress = interpolate(
		frame,
		[dissolveStart, durationInFrames],
		[1, 1.2],
		{easing: Easing.out(Easing.quad), extrapolateLeft: 'clamp'}
	);

	// Overlay Text
	const textOpacity = interpolate(
		frame,
		[dissolveEnd, dissolveEnd + 15],
		[0, 1],
		{extrapolateLeft: 'clamp'}
	);

	return (
		<AbsoluteFill style={{backgroundColor: '#1a1a1a'}}>
			{/* Background (The path after wall disappears) */}
			<AbsoluteFill
				style={{
					transform: `scale(${walkProgress})`,
				}}
			>
				<Img
					src={staticFile('two_roads.png')} // Reusing an asset as the "free path"
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
						filter: 'brightness(0.8)',
					}}
				/>
			</AbsoluteFill>

			{/* The Wall (The obstacle) */}
			<AbsoluteFill
				style={{
					opacity: wallOpacity,
					filter: `blur(${wallBlur}px)`,
					transform: `scale(${walkProgress})`,
				}}
			>
				<Img
					src={staticFile('wall_disappears.png')}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
					}}
				/>
			</AbsoluteFill>

			{/* Sunlight/Hope rays after dissolve */}
			<AbsoluteFill
				style={{
					background: 'radial-gradient(circle at 50% 30%, rgba(255, 255, 200, 0.2) 0%, transparent 70%)',
					opacity: 1 - wallOpacity,
					mixBlendMode: 'screen',
					pointerEvents: 'none',
				}}
			/>

			{/* Overlay Text */}
			<AbsoluteFill className="justify-center items-center">
				<div 
					className="bg-blue-600/80 px-10 py-5 rounded-full border-2 border-white/50 shadow-2xl backdrop-blur-sm"
					style={{opacity: textOpacity}}
				>
					<h2 
						className="text-white text-5xl font-black uppercase tracking-widest"
						style={{fontFamily: 'Inter, sans-serif'}}
					>
						Обстоятельства устранены
					</h2>
				</div>
			</AbsoluteFill>

			<Audio src={staticFile('shot30_voice.mp3')} />
		</AbsoluteFill>
	);
};
